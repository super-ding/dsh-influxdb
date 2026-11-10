/**
 * dsh-influxdb - Host half.
 *
 * Talks to InfluxDB 2.x over its HTTP API (no client library, no dependency, so
 * the bundle loads from any profile layout):
 *
 *   GET  /health                connection check
 *   POST /api/v2/query          Flux execution (annotated CSV)
 *   POST /api/v2/query/analyze  Flux parse/validation (AST)
 *   GET  /api/v2/buckets        bucket list
 *   POST /api/v2/write          line protocol (opt-in through `allowWrite`)
 *
 * Two front ends share the same operations:
 *
 *   1. Agent tools (`influx_connections`, `influx_query`, `influx_schema`,
 *      `influx_buckets`, `influx_write`, `influx_flux`).
 *   2. The panel's single RPC route `POST /influxdb/rpc`, loopback only, which
 *      the Client half calls for the same operations plus connection editing.
 *
 * Connection editing persists through the profile's `configEditor` (the row's
 * own patch config) and is also applied to the live state immediately, so a
 * save takes effect with or without a plugin restart.
 *
 * @module dsh-influxdb
 */

/** Cordis plugin name shown by the loader. */
export const name = "dsh-influxdb";

/** Version reported by the health route. */
export const HOST_VERSION = "1.0.0";

const RPC_PATH = "/influxdb/rpc";
const HEALTH_PATH = "/influxdb/health";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS_CEILING = 2000;
const MAX_CELL_CHARS = 4000;
const MAX_LINE_CHARS = 512 * 1024;

/** Live configuration; `apply` seeds it and the panel updates it in place. */
const state = {
  config: normalizeConfig(undefined),
  lastQuery: null,
};

/* ------------------------------------------------------------------ config */

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const connections = Array.isArray(source.connections) ? source.connections.map(normalizeConnection).filter(Boolean) : [];
  const unique = [];
  const seen = new Set();
  for (const connection of connections) {
    if (seen.has(connection.id)) continue;
    seen.add(connection.id);
    unique.push(connection);
  }
  if (unique.length > 0 && !unique.some((c) => c.default)) unique[0].default = true;
  return {
    connections: unique,
    allowWrite: source.allowWrite === true,
    timeoutMs: clampInt(source.timeoutMs, 1000, 300000, 30000),
    maxRows: clampInt(source.maxRows, 1, MAX_ROWS_CEILING, 200),
  };
}

function normalizeConnection(value) {
  if (value === null || typeof value !== "object") return null;
  const url = normalizeBaseUrl(value.url);
  if (url === "") return null;
  const id = String(value.id ?? "").trim() || deriveId(url);
  return {
    id: id.slice(0, 64),
    label: String(value.label ?? "").trim().slice(0, 80) || id,
    url,
    org: String(value.org ?? "").trim(),
    bucket: String(value.bucket ?? "").trim(),
    token: String(value.token ?? "").trim(),
    tokenEnv: String(value.tokenEnv ?? "").trim(),
    default: value.default === true,
  };
}

function deriveId(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname + (parsed.port ? "-" + parsed.port : "")).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "influx";
  } catch {
    return "influx";
  }
}

function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/* ------------------------------------------------------------- connections */

function listConnections() {
  return state.config.connections;
}

function publicConnection(connection, extra = {}) {
  const token = resolveToken(connection);
  return {
    id: connection.id,
    label: connection.label,
    url: connection.url,
    org: connection.org,
    bucket: connection.bucket,
    default: connection.default === true,
    tokenFrom: connection.tokenEnv !== "" ? "env" : token !== "" ? "config" : "none",
    tokenEnv: connection.tokenEnv,
    tokenHint: token === "" ? "" : "***" + token.slice(-4),
    hasToken: token !== "",
    ...extra,
  };
}

/** The token itself, resolved from the configured env name when one is set. */
function resolveToken(connection) {
  const named = connection.tokenEnv;
  if (named !== "") {
    const fromEnv = process.env[named];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  }
  const inline = connection.token;
  if (inline.startsWith("env:") || inline.startsWith("$")) {
    const key = inline.replace(/^env:/, "").replace(/^\$\{?/, "").replace(/\}$/, "");
    const fromEnv = process.env[key];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
    return "";
  }
  return inline;
}

function resolveConnection(idOrUndefined) {
  const connections = listConnections();
  if (connections.length === 0) {
    throw new InfluxError("no connection configured: add one in the InfluxDB panel or cordis.patch.yml", 400, "NO_CONNECTION");
  }
  const wanted = String(idOrUndefined ?? "").trim();
  if (wanted !== "") {
    const found = connections.find((c) => c.id === wanted);
    if (found === undefined) {
      throw new InfluxError(`unknown connection "${wanted}"; configured: ${connections.map((c) => c.id).join(", ")}`, 404, "UNKNOWN_CONNECTION");
    }
    return found;
  }
  return connections.find((c) => c.default) ?? connections[0];
}

/* --------------------------------------------------------------- transport */

class InfluxError extends Error {
  constructor(message, status = 500, code = "INFLUX_ERROR") {
    super(message);
    this.name = "InfluxError";
    this.status = status;
    this.code = code;
  }
}

function requireToken(connection) {
  const token = resolveToken(connection);
  if (token === "") {
    const hint = connection.tokenEnv !== "" ? `environment variable ${connection.tokenEnv} is empty` : "no token configured";
    throw new InfluxError(`connection "${connection.id}" has no usable token: ${hint}`, 401, "NO_TOKEN");
  }
  return token;
}

async function influxFetch(connection, path, options = {}) {
  const { method = "GET", body, rawBody, rawContentType = "text/plain; charset=utf-8", query, accept = "application/json", token, timeoutMs } = options;
  const url = new URL(connection.url + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const headers = { accept };
  if (token !== null) headers.authorization = `Token ${token ?? requireToken(connection)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (rawBody !== undefined) headers["content-type"] = rawContentType;
  const timeout = clampInt(timeoutMs, 1000, 300000, state.config.timeoutMs);
  const signal = AbortSignal.timeout(timeout);
  const started = Date.now();
  const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
  let response;
  try {
    response = await fetch(url, { method, headers, body: payload, signal });
  } catch (error) {
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? `timed out after ${timeout} ms` : String(error?.message ?? error);
    throw new InfluxError(`cannot reach ${connection.url} (${method} ${path}): ${reason}`, 502, "UNREACHABLE");
  }
  const durationMs = Date.now() - started;
  const text = await response.text();
  if (!response.ok) {
    throw new InfluxError(describeFailure(response.status, text), response.status, "INFLUX_HTTP_" + response.status);
  }
  return { status: response.status, text, durationMs };
}

function describeFailure(status, text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return `InfluxDB answered HTTP ${status}`;
  try {
    const parsed = JSON.parse(trimmed);
    const message = parsed.message ?? parsed.error;
    if (typeof message === "string" && message !== "") return `InfluxDB HTTP ${status}: ${message}`;
  } catch {
    /* not JSON: fall through to the raw body */
  }
  return `InfluxDB HTTP ${status}: ${trimmed.slice(0, 800)}`;
}

/* ------------------------------------------------------------------- parse */

/** Split one CSV record, honouring quoted fields and doubled quotes. */
function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      cells.push(current);
      current = "";
    } else current += character;
  }
  cells.push(current);
  return cells;
}

function coerceCell(value, datatype) {
  if (datatype === undefined) return value;
  const type = String(datatype);
  if (value === "") return null;
  if (type === "double" || type === "long" || type === "unsignedLong") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") return value === "true";
  return value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value;
}

/**
 * Turn annotated Flux CSV into tables. Rows stop at `limit` so one runaway
 * query cannot flood the model context or the panel.
 */
function parseFluxCsv(text, limit) {
  const tables = [];
  let columns = null;
  let datatypes = null;
  let group = null;
  let rows = [];
  let truncated = false;
  let total = 0;

  const flush = () => {
    if (columns !== null) {
      // The annotated CSV header carries a leading annotation column; drop it so
      // the panel and tool output do not show one unnamed blank column.
      const dropLeading = columns.length > 0 && columns[0] === "";
      const kept = dropLeading ? columns.slice(1) : columns;
      const keptTypes = dropLeading ? (datatypes ?? []).slice(1) : datatypes;
      const keptGroup = dropLeading ? (group ?? []).slice(1) : group;
      const keptRows = dropLeading ? rows.map((row) => row.slice(1)) : rows;
      tables.push({ columns: kept, datatypes: keptTypes, group: keptGroup, rows: keptRows });
    }
    columns = null;
    rows = [];
  };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "") {
      flush();
      if (truncated) break;
      continue;
    }
    if (line.startsWith("#")) {
      const parts = line.slice(1).split(",");
      const tag = parts.shift();
      if (tag === "datatype") datatypes = parts;
      else if (tag === "group") group = parts;
      continue;
    }
    const cells = splitCsvLine(line);
    if (columns === null) {
      columns = cells;
      continue;
    }
    if (total >= limit) {
      truncated = true;
      break;
    }
    rows.push(cells.map((cell, index) => coerceCell(cell, datatypes?.[index])));
    total += 1;
  }
  flush();
  return { tables: tables.filter((table) => table.columns !== null), rowCount: total, truncated };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ---------------------------------------------------------------- operations */

async function ping(connection) {
  const started = Date.now();
  try {
    const result = await influxFetch(connection, "/health", { token: null, timeoutMs: 8000 });
    let body = {};
    try {
      body = JSON.parse(result.text);
    } catch {
      body = {};
    }
    return {
      ok: body.status === "pass" || result.status === 200,
      status: String(body.status ?? "unknown"),
      version: String(body.version ?? ""),
      message: String(body.message ?? ""),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, status: "fail", version: "", message: String(error?.message ?? error), durationMs: Date.now() - started };
  }
}

async function runFlux(connection, flux, options = {}) {
  const query = String(flux ?? "");
  if (query.trim() === "") throw new InfluxError("query is empty", 400, "EMPTY_QUERY");
  if (query.length > MAX_LINE_CHARS) throw new InfluxError(`query is too long (${query.length} characters, limit ${MAX_LINE_CHARS})`, 400, "QUERY_TOO_LONG");
  const org = String(options.org ?? "").trim() || connection.org;
  if (org === "") throw new InfluxError(`connection "${connection.id}" has no org; set one on the connection or pass org`, 400, "NO_ORG");
  const limit = clampInt(options.maxRows, 1, MAX_ROWS_CEILING, state.config.maxRows);
  const result = await influxFetch(connection, "/api/v2/query", {
    method: "POST",
    query: { org },
    accept: "application/csv",
    body: {
      query,
      type: "flux",
      dialect: { header: true, delimiter: ",", commentPrefix: "#", annotations: ["datatype", "group", "default"] },
    },
  });
  const parsed = parseFluxCsv(result.text, limit);
  state.lastQuery = { connection: connection.id, at: new Date().toISOString(), durationMs: result.durationMs, rowCount: parsed.rowCount };
  return {
    connection: connection.id,
    org,
    durationMs: result.durationMs,
    rowCount: parsed.rowCount,
    rowLimit: limit,
    truncated: parsed.truncated,
    tables: parsed.tables.map((table) => ({
      columns: table.columns,
      group: table.group,
      rows: table.rows.slice(0, limit),
    })),
  };
}

async function listBuckets(connection) {
  const org = connection.org;
  // InfluxDB 2.1 rejects limit > 100 (400 "limit must be between 1 and 100"), so
  // page through at 100 per request and stop when a short page arrives.
  const body = { buckets: [] };
  for (let offset = 0; offset < 1000; offset += 100) {
    const result = await influxFetch(connection, "/api/v2/buckets", {
      query: { org: org === "" ? undefined : org, limit: 100, offset },
    });
    let page;
    try {
      page = JSON.parse(result.text);
    } catch {
      throw new InfluxError("InfluxDB returned a non-JSON bucket list", 502, "BAD_BUCKETS_JSON");
    }
    const items = Array.isArray(page.buckets) ? page.buckets : [];
    body.buckets.push(...items);
    if (items.length < 100) break;
  }
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  return buckets.map((bucket) => {
    const rule = Array.isArray(bucket.retentionRules) ? bucket.retentionRules[0] : undefined;
    const seconds = Number(rule?.everySeconds ?? 0);
    return {
      name: String(bucket.name ?? ""),
      id: String(bucket.id ?? ""),
      type: String(bucket.type ?? ""),
      retention: seconds > 0 ? `${Math.round(seconds / 86400)}d` : "infinite",
      retentionSeconds: seconds,
      createdAt: String(bucket.createdAt ?? ""),
      orgID: String(bucket.orgID ?? ""),
    };
  });
}

const SCHEMA_QUERIES = {
  buckets: () => "buckets()\n  |> keep(columns: [\"name\", \"id\", \"retentionPolicy\", \"retentionPeriod\"])",
  measurements: (args) =>
    [
      'import "influxdata/influxdb/schema"',
      "",
      `schema.measurements(bucket: ${fluxString(args.bucket)})`,
    ].join("\n"),
  fields: (args) =>
    [
      'import "influxdata/influxdb/schema"',
      "",
      `schema.measurementFieldKeys(bucket: ${fluxString(args.bucket)}, measurement: ${fluxString(args.measurement)})`,
    ].join("\n"),
  tags: (args) =>
    [
      'import "influxdata/influxdb/schema"',
      "",
      `schema.measurementTagKeys(bucket: ${fluxString(args.bucket)}, measurement: ${fluxString(args.measurement)})`,
    ].join("\n"),
  tagValues: (args) =>
    [
      'import "influxdata/influxdb/schema"',
      "",
      `schema.tagValues(bucket: ${fluxString(args.bucket)}, tag: ${fluxString(args.tag)})`,
    ].join("\n"),
};

function fluxString(value) {
  const text = String(value ?? "").trim();
  if (text === "") return '""';
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function readSchema(connection, args) {
  const action = String(args.action ?? "measurements");
  const build = SCHEMA_QUERIES[action];
  if (build === undefined) {
    throw new InfluxError(`unknown schema action "${action}"; use one of ${Object.keys(SCHEMA_QUERIES).join(", ")}`, 400, "BAD_ACTION");
  }
  const bucket = String(args.bucket ?? "").trim() || connection.bucket;
  if (bucket === "" ) throw new InfluxError("a bucket is required for schema queries", 400, "NO_BUCKET");
  if ((action === "fields" || action === "tags") && String(args.measurement ?? "").trim() === "") {
    throw new InfluxError(`measurement is required for ${action}`, 400, "NO_MEASUREMENT");
  }
  if (action === "tagValues" && String(args.tag ?? "").trim() === "") {
    throw new InfluxError("tag is required for tagValues", 400, "NO_TAG");
  }
  const flux = build({ bucket, measurement: String(args.measurement ?? "").trim(), tag: String(args.tag ?? "").trim() });
  const result = await runFlux(connection, flux, { maxRows: clampInt(args.maxRows, 1, MAX_ROWS_CEILING, 500) });
  const values = [];
  for (const table of result.tables) {
    const index = table.columns.indexOf("_value");
    if (index < 0) continue;
    for (const row of table.rows) {
      const value = row[index];
      if (value !== null && value !== undefined && String(value) !== "") values.push(String(value));
    }
  }
  return { connection: connection.id, bucket, action, flux, values, valueCount: values.length, durationMs: result.durationMs };
}

async function writeLines(connection, args) {
  if (!state.config.allowWrite) {
    throw new InfluxError(
      "writing is disabled: set allowWrite: true on the dsh-influxdb plugin row (or in the panel) before using influx_write",
      403,
      "WRITE_DISABLED",
    );
  }
  const bucket = String(args.bucket ?? "").trim() || connection.bucket;
  if (bucket === "") throw new InfluxError("a bucket is required to write", 400, "NO_BUCKET");
  const lines = String(args.lines ?? "").trim();
  if (lines === "") throw new InfluxError("lines is empty", 400, "EMPTY_WRITE");
  const org = String(args.org ?? "").trim() || connection.org;
  if (org === "") throw new InfluxError(`connection "${connection.id}" has no org`, 400, "NO_ORG");
  const precision = ["ns", "us", "ms", "s"].includes(String(args.precision ?? "")) ? String(args.precision) : "ns";
  const result = await influxFetch(connection, "/api/v2/write", {
    method: "POST",
    query: { org, bucket, precision },
    accept: "application/json",
    body: undefined,
    token: requireToken(connection),
    // The write API takes the line protocol as the raw body; influxFetch JSON-encodes objects only.
    rawBody: lines,
  });
  return { connection: connection.id, org, bucket, precision, status: result.status, accepted: true, durationMs: result.durationMs, lineCount: lines.split(/\r?\n/).filter((line) => line.trim() !== "").length };
}

async function analyzeFlux(connection, args) {
  const query = String(args.query ?? "");
  if (query.trim() === "") throw new InfluxError("query is empty", 400, "EMPTY_QUERY");
  const org = String(args.org ?? "").trim() || connection.org;
  if (org === "") throw new InfluxError(`connection "${connection.id}" has no org`, 400, "NO_ORG");
  try {
    const result = await influxFetch(connection, "/api/v2/query/analyze", { method: "POST", query: { org }, body: { query, type: "flux" } });
    let ast = null;
    try {
      ast = JSON.parse(result.text);
    } catch {
      ast = null;
    }
    const calls = [];
    walkAst(ast, (node) => {
      if (node?.type === "CallExpression") calls.push(callName(node.callee));
      if (node?.type === "PipeExpression") calls.push(callName(node.call?.callee));
    });
    return {
      valid: true,
      connection: connection.id,
      org,
      durationMs: result.durationMs,
      stages: calls.filter((entry) => entry !== ""),
      ast: ast === null ? null : shrinkAst(ast),
    };
  } catch (error) {
    if (error instanceof InfluxError) {
      return { valid: false, connection: connection.id, org, error: error.message, code: error.code, stages: [], ast: null };
    }
    throw error;
  }
}

function callName(callee) {
  if (callee === null || callee === undefined) return "";
  if (callee.type === "Identifier") return String(callee.name ?? "");
  if (callee.type === "MemberExpression") {
    const object = callName(callee.object);
    const property = callee.property?.type === "Identifier" ? callee.property.name : callName(callee.property);
    return object === "" ? String(property ?? "") : `${object}.${property}`;
  }
  return "";
}

function walkAst(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") walkAst(value, visit);
  }
}

/** Keep only the shape that explains a pipeline; the raw AST is huge. */
function shrinkAst(node, depth = 0) {
  if (depth > 6) return "…";
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.slice(0, 20).map((item) => shrinkAst(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "location" || key === "sourceLocation") continue;
    out[key] = shrinkAst(value, depth + 1);
  }
  return out;
}

/* --------------------------------------------------------------- templates */

const TEMPLATES = [
  {
    id: "raw",
    title: "基础查询 Basic range/filter",
    params: { bucket: "", measurement: "", field: "", start: "-1h" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
      ].join("\n"),
  },
  {
    id: "window",
    title: "窗口聚合 aggregateWindow",
    params: { bucket: "", measurement: "", field: "", start: "-24h", every: "5m", fn: "mean" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
        `  |> aggregateWindow(every: ${p.every || "5m"}, fn: ${p.fn || "mean"}, createEmpty: false)`,
        `  |> keep(columns: ["_time", "_value"])`,
      ].join("\n"),
  },
  {
    id: "latest",
    title: "最新值 last",
    params: { bucket: "", measurement: "", start: "-1h" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> last()`,
      ].join("\n"),
  },
  {
    id: "rate",
    title: "变化率 derivative",
    params: { bucket: "", measurement: "", field: "", start: "-1h", unit: "1s" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
        `  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)`,
        `  |> derivative(unit: ${p.unit || "1s"}, nonNegative: true)`,
        `  |> yield(name: "rate")`,
      ].join("\n"),
  },
  {
    id: "pivot",
    title: "字段转列 pivot",
    params: { bucket: "", measurement: "", start: "-6h" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`,
        `  |> keep(columns: ["_time"])  // 保留需要的字段列`,
      ].join("\n"),
  },
  {
    id: "groupcount",
    title: "按标签分组计数",
    params: { bucket: "", measurement: "", tag: "host", start: "-1h" },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> group(columns: [${fluxString(p.tag)}])`,
        `  |> count()`,
        `  |> keep(columns: [${fluxString(p.tag)}, "_value"])`,
      ].join("\n"),
  },
  {
    id: "topn",
    title: "TopN",
    params: { bucket: "", measurement: "", field: "", tag: "host", start: "-1h", n: 5 },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
        `  |> group(columns: [${fluxString(p.tag)}])`,
        `  |> sum()`,
        `  |> sort(columns: ["_value"], desc: true)`,
        `  |> limit(n: ${clampInt(p.n, 1, 1000, 5)})`,
      ].join("\n"),
  },
  {
    id: "join",
    title: "双指标 join",
    params: { bucket: "", measurement: "", fieldA: "", fieldB: "", start: "-1h" },
    build: (p) =>
      [
        `a = from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.fieldA)})`,
        "",
        `b = from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.fieldB)})`,
        "",
        `join(tables: {a: a, b: b}, on: ["_time"])`,
        `  |> keep(columns: ["_time", "_value_a", "_value_b"])`,
        `  |> yield(name: "joined")`,
      ].join("\n"),
  },
  {
    id: "threshold",
    title: "阈值状态 map",
    params: { bucket: "", measurement: "", field: "", start: "-1h", warn: 80, crit: 90 },
    build: (p) =>
      [
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
        `  |> map(fn: (r) => ({`,
        `    r with`,
        `    state: if r._value >= ${Number(p.crit) || 90} then "critical"`,
        `           else if r._value >= ${Number(p.warn) || 80} then "warning"`,
        `           else "ok"`,
        `  }))`,
      ].join("\n"),
  },
  {
    id: "downsample",
    title: "降采样写入新 bucket",
    params: { bucket: "", measurement: "", field: "", start: "-7d", every: "1h", target: "" },
    build: (p) =>
      [
        `option task = {name: "downsample-${p.measurement || "measurement"}", every: 1h}`,
        "",
        `from(bucket: ${fluxString(p.bucket)})`,
        `  |> range(start: ${fluxRange(p.start)})`,
        `  |> filter(fn: (r) => r._measurement == ${fluxString(p.measurement)})`,
        `  |> filter(fn: (r) => r._field == ${fluxString(p.field)})`,
        `  |> aggregateWindow(every: ${p.every || "1h"}, fn: mean, createEmpty: false)`,
        `  |> to(bucket: ${fluxString(p.target)}, org: "")`,
      ].join("\n"),
  },
];

/** `-1h` becomes a duration literal; a date becomes a time literal. */
function fluxRange(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "-1h";
  if (/^-?\d+[smhdwMoOy]$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return `time(v: ${fluxString(text)})`;
  return text;
}

function buildTemplate(args) {
  const id = String(args.template ?? "");
  const template = TEMPLATES.find((entry) => entry.id === id);
  if (template === undefined) {
    throw new InfluxError(`unknown template "${id}"; available: ${TEMPLATES.map((t) => t.id).join(", ")}`, 400, "UNKNOWN_TEMPLATE");
  }
  const params = { ...template.params, ...(typeof args.params === "object" && args.params !== null ? args.params : {}) };
  return { template: template.id, title: template.title, params, flux: template.build(params) };
}

/* ---------------------------------------------------------------- response */

function tableToText(result, maxRowsInText = 40) {
  const lines = [];
  for (const [index, table] of result.tables.entries()) {
    if (result.tables.length > 1) lines.push(`-- table ${index + 1} --`);
    lines.push(table.columns.join(" | "));
    lines.push(table.columns.map(() => "---").join(" | "));
    for (const row of table.rows.slice(0, maxRowsInText)) {
      lines.push(row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))).join(" | "));
    }
    if (table.rows.length > maxRowsInText) lines.push(`… ${table.rows.length - maxRowsInText} more rows in this table`);
  }
  if (lines.length === 0) lines.push("(no rows)");
  return lines.join("\n");
}

function bounded(text, limit = 12000) {
  const value = String(text ?? "");
  return value.length <= limit ? value : value.slice(0, limit) + `\n… truncated ${value.length - limit} characters`;
}

/* -------------------------------------------------------------------- tools */

function defineInfluxTool(ctx, definition) {
  ctx.effect(() => ctx.tools.register(definition), `dsh-influxdb: ${definition.name}`);
}

function registerTools(tctx) {
  defineInfluxTool(tctx, {
    name: "influx_connections",
    description:
      "List the InfluxDB 2.x connections this profile is configured with (url, org, default bucket, token presence) and optionally check each one's /health endpoint. Call this first when a task mentions InfluxDB and you do not know which connection to use.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ping: { type: "boolean", description: "Also call each connection's /health endpoint and report reachability. Defaults to false." },
        connection: { type: "string", description: "Limit the result to one connection id." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                url: { type: "string" },
                org: { type: "string" },
                bucket: { type: "string" },
                default: { type: "boolean" },
                hasToken: { type: "boolean" },
                tokenFrom: { type: "string" },
                tokenEnv: { type: "string" },
                tokenHint: { type: "string" },
                health: { type: "string" },
                version: { type: "string" },
                latencyMs: { type: "number" },
              },
            },
          },
          count: { type: "number" },
          note: { type: "string" },
        },
      },
      render(_args, value) {
        if (value.count === 0) return textBlocks("No InfluxDB connection is configured yet. Add one in the InfluxDB panel, or set `connections` on the dsh-influxdb plugin row.");
        const lines = value.connections.map((connection) => {
          const bits = [`${connection.id} (${connection.label})`, connection.url];
          if (connection.org) bits.push(`org=${connection.org}`);
          if (connection.bucket) bits.push(`bucket=${connection.bucket}`);
          bits.push(connection.default ? "default" : "secondary");
          bits.push(connection.hasToken ? `token ${connection.tokenFrom}${connection.tokenEnv ? `:${connection.tokenEnv}` : ""}` : "NO TOKEN");
          if (connection.health) bits.push(`health=${connection.health}${connection.version ? ` ${connection.version}` : ""}${connection.latencyMs !== undefined ? ` ${connection.latencyMs}ms` : ""}`);
          return "- " + bits.join(" · ");
        });
        return textBlocks((value.note ? value.note + "\n" : "") + lines.join("\n"));
      },
    },
    async execute(args) {
      const wanted = String(args.connection ?? "").trim();
      const connections = listConnections().filter((connection) => wanted === "" || connection.id === wanted);
      const output = [];
      for (const connection of connections) {
        const extra = {};
        if (args.ping === true) {
          const health = await ping(connection);
          extra.health = health.status;
          extra.version = health.version;
          extra.latencyMs = health.durationMs;
          if (!health.ok && health.message) extra.health = `fail: ${health.message.slice(0, 200)}`;
        }
        output.push(publicConnection(connection, extra));
      }
      const note =
        listConnections().length === 0
          ? "no connection configured"
          : state.config.allowWrite
            ? "writing is enabled"
            : "writing is disabled (allowWrite: false)";
      return { connections: output, count: output.length, note };
    },
  });

  defineInfluxTool(tctx, {
    name: "influx_query",
    description:
      "Run a Flux query against an InfluxDB 2.x connection and return the result tables. Returns column names plus row arrays, capped by rowLimit with truncated flagged, so a wide or unbounded query cannot flood the conversation; narrow the range/filter or raise maxRows when you need more.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Complete Flux script, including the from()/range() pipeline." },
        connection: { type: "string", description: "Connection id; defaults to the connection marked default." },
        org: { type: "string", description: "Org override; defaults to the connection's org." },
        maxRows: { type: "integer", minimum: 1, maximum: 2000, description: "Row cap for this call; defaults to the plugin's maxRows setting." },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connection: { type: "string" },
          org: { type: "string" },
          durationMs: { type: "number" },
          rowCount: { type: "number" },
          rowLimit: { type: "number" },
          truncated: { type: "boolean" },
          tables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                columns: { type: "array", items: { type: "string" } },
                group: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: {} } },
              },
            },
          },
        },
      },
      render(_args, value) {
        const header = `${value.rowCount} row(s) in ${value.tables.length} table(s), ${value.durationMs} ms${value.truncated ? " — TRUNCATED at the row limit" : ""}`;
        return textBlocks(header + "\n\n" + bounded(tableToText(value)));
      },
    },
    async execute(args) {
      const connection = resolveConnection(args.connection);
      return runFlux(connection, args.query, { org: args.org, maxRows: args.maxRows });
    },
  });

  defineInfluxTool(tctx, {
    name: "influx_schema",
    description:
      "Read InfluxDB schema metadata through the Flux schema package: bucket list, measurement names, a measurement's field keys or tag keys, or one tag's values. Use it before writing a query so measurements, fields and tags in the query actually exist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["buckets", "measurements", "fields", "tags", "tagValues"],
          description: "Which metadata to read. fields and tags need a measurement; tagValues needs a measurement and a tag.",
        },
        connection: { type: "string", description: "Connection id; defaults to the connection marked default." },
        bucket: { type: "string", description: "Bucket to inspect; defaults to the connection's bucket." },
        measurement: { type: "string", description: "Measurement name for fields, tags and tagValues." },
        tag: { type: "string", description: "Tag key whose values to list, for tagValues." },
        maxRows: { type: "integer", minimum: 1, maximum: 2000, description: "Row cap; defaults to 500." },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connection: { type: "string" },
          bucket: { type: "string" },
          action: { type: "string" },
          values: { type: "array", items: { type: "string" } },
          valueCount: { type: "number" },
          durationMs: { type: "number" },
          flux: { type: "string" },
        },
      },
      render(_args, value) {
        const list = value.values.length === 0 ? "(none)" : value.values.slice(0, 200).map((entry) => "- " + entry).join("\n");
        return textBlocks(`${value.action} in bucket "${value.bucket}": ${value.valueCount} value(s), ${value.durationMs} ms\n${list}`);
      },
    },
    async execute(args) {
      const connection = resolveConnection(args.connection);
      return readSchema(connection, args);
    },
  });

  defineInfluxTool(tctx, {
    name: "influx_buckets",
    description:
      "List the buckets of an InfluxDB 2.x org with their id, type and retention period. Use it to discover where data lives or where to write before running a query.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        connection: { type: "string", description: "Connection id; defaults to the connection marked default." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connection: { type: "string" },
          count: { type: "number" },
          buckets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                id: { type: "string" },
                type: { type: "string" },
                retention: { type: "string" },
                retentionSeconds: { type: "number" },
                createdAt: { type: "string" },
                orgID: { type: "string" },
              },
            },
          },
        },
      },
      render(_args, value) {
        const lines = value.buckets.map((bucket) => `- ${bucket.name} · ${bucket.type} · retention ${bucket.retention}`);
        return textBlocks(`connection ${value.connection}: ${value.count} bucket(s)\n` + (lines.join("\n") || "(none)"));
      },
    },
    async execute(args) {
      const connection = resolveConnection(args.connection);
      const buckets = await listBuckets(connection);
      return { connection: connection.id, count: buckets.length, buckets };
    },
  });

  defineInfluxTool(tctx, {
    name: "influx_write",
    description:
      "Write InfluxDB line protocol points into a bucket. Disabled unless the dsh-influxdb plugin row sets allowWrite: true; when disabled the call fails with WRITE_DISABLED and nothing is sent. Each line is `measurement,tag=value field=1.0 <ns timestamp>`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        lines: { type: "string", description: "Line protocol body, one point per line. Timestamps are optional." },
        connection: { type: "string", description: "Connection id; defaults to the connection marked default." },
        bucket: { type: "string", description: "Target bucket; defaults to the connection's bucket." },
        org: { type: "string", description: "Org override; defaults to the connection's org." },
        precision: { type: "string", enum: ["ns", "us", "ms", "s"], description: "Timestamp precision of the supplied points; defaults to ns." },
      },
      required: ["lines"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connection: { type: "string" },
          org: { type: "string" },
          bucket: { type: "string" },
          precision: { type: "string" },
          accepted: { type: "boolean" },
          lineCount: { type: "number" },
          durationMs: { type: "number" },
          status: { type: "number" },
        },
      },
      render(_args, value) {
        return textBlocks(`wrote ${value.lineCount} line(s) to ${value.bucket} (org ${value.org}, precision ${value.precision}) in ${value.durationMs} ms — HTTP ${value.status}`);
      },
    },
    async execute(args) {
      const connection = resolveConnection(args.connection);
      return writeLines(connection, args);
    },
  });

  defineInfluxTool(tctx, {
    name: "influx_flux",
    description:
      "Flux authoring assistant. action=validate parses a script server-side and returns whether it is valid plus the ordered pipeline stages; action=explain also summarises how the script flows; action=template builds a parameterised starting point (raw, window, latest, rate, pivot, groupcount, topn, join, threshold, downsample); action=params lists the template ids. Use it to check Flux before running it and to get a correct starting script.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["validate", "explain", "template", "params"], description: "What to do." },
        query: { type: "string", description: "Flux script for validate/explain." },
        template: { type: "string", description: "Template id for action=template." },
        params: {
          type: "object",
          additionalProperties: true,
          description: "Template parameter overrides: bucket, measurement, field, start, every, fn, tag, n, warn, crit, target.",
        },
        connection: { type: "string", description: "Connection id; defaults to the connection marked default." },
        org: { type: "string", description: "Org override for validate/explain; defaults to the connection's org." },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          valid: { type: "boolean" },
          stages: { type: "array", items: { type: "string" } },
          error: { type: "string" },
          summary: { type: "string" },
          template: { type: "string" },
          flux: { type: "string" },
          connection: { type: "string" },
          org: { type: "string" },
          durationMs: { type: "number" },
          ast: {},
          templates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, title: { type: "string" }, params: { type: "object", additionalProperties: true } },
            },
          },
        },
      },
      render(_args, value) {
        if (value.action === "params") {
          return textBlocks(value.templates.map((entry) => `- ${entry.id}: ${entry.title}`).join("\n"));
        }
        if (value.action === "template") {
          return textBlocks(`# ${value.template}\n\n` + bounded(value.flux, 6000));
        }
        const status = value.valid ? "valid Flux" : "INVALID Flux";
        const details = [status];
        if (value.summary) details.push(value.summary);
        if (value.stages?.length) details.push("stages: " + value.stages.join(" → "));
        if (value.error) details.push("error: " + value.error);
        return textBlocks(details.join("\n"));
      },
    },
    async execute(args) {
      const action = String(args.action ?? "");
      if (action === "params") {
        return { action, valid: true, templates: TEMPLATES.map((entry) => ({ id: entry.id, title: entry.title, params: { ...entry.params } })), stages: [] };
      }
      if (action === "template") {
        const built = buildTemplate(args);
        return { action, valid: true, template: built.template, flux: built.flux, stages: [] };
      }
      if (action !== "validate" && action !== "explain") {
        throw new InfluxError(`unknown action "${action}"; use validate, explain, template or params`, 400, "BAD_ACTION");
      }
      const connection = resolveConnection(args.connection);
      const analyzed = await analyzeFlux(connection, args);
      const summary =
        action === "explain" && analyzed.valid === true
          ? explainSummary(analyzed.stages, String(args.query ?? ""))
          : undefined;
      return {
        action,
        valid: analyzed.valid === true,
        stages: analyzed.stages ?? [],
        error: analyzed.error ?? "",
        summary: summary ?? "",
        templates: [],
      };
    },
  });
}

/** A one-line explanation of a Flux pipeline, keyed on the stages it contains. */
function explainSummary(stages, query) {
  const notes = [];
  if (stages.includes("from")) notes.push("reads from a bucket");
  if (stages.includes("range")) notes.push("restricts the time window");
  if (stages.includes("filter")) notes.push(`filters ${(query.match(/filter\(/g) ?? []).length} time(s)`);
  if (stages.includes("aggregateWindow")) notes.push("aggregates into fixed windows");
  if (stages.includes("group")) notes.push("re-groups series");
  if (stages.includes("pivot")) notes.push("pivots fields into columns");
  if (stages.includes("join")) notes.push("joins two streams on a key");
  if (stages.includes("map")) notes.push("derives new columns");
  if (stages.includes("derivative")) notes.push("computes a per-time-unit rate");
  if (stages.includes("last")) notes.push("keeps the newest point");
  if (stages.includes("limit")) notes.push("caps the row count");
  if (stages.includes("to")) notes.push("writes the result into a bucket");
  if (stages.includes("yield")) notes.push("names the result");
  return notes.length === 0 ? "pipeline has no recognised transformation" : "pipeline: " + notes.join(", ");
}

function textBlocks(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

/* ------------------------------------------------------------------- routes */

function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InfluxError("request body too large", 413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InfluxError("request body is not valid JSON", 400, "BAD_JSON");
  }
}

/** The plugin row's config, edited through the profile's config editor. */
async function saveConfig(ctx, patch) {
  const entry = ctx.fiber?.entry;
  const editor = ctx.get("configEditor");
  if (entry === undefined || editor === undefined) {
    throw new InfluxError("this profile cannot persist plugin configuration; edit the dsh-influxdb row in cordis.patch.yml instead", 409, "NO_CONFIG_EDITOR");
  }
  let nextConfig = null;
  await editor.edit(entry, (current) => {
    const merged = { ...(current ?? {}), ...patch };
    nextConfig = merged;
    return merged;
  });
  return nextConfig;
}

async function handleRpc(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "POST only" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error?.status ?? 400, { ok: false, error: String(error?.message ?? error) });
    return;
  }
  const op = String(payload?.op ?? "");
  try {
    const value = await runRpcOperation(ctx, op, payload ?? {});
    sendJson(res, 200, { ok: true, value });
  } catch (error) {
    const status = error instanceof InfluxError ? error.status : 500;
    sendJson(res, status, { ok: false, error: String(error?.message ?? error), code: error?.code ?? "RPC_FAILED" });
  }
}

async function runRpcOperation(ctx, op, payload) {
  switch (op) {
    case "state": {
      return {
        version: HOST_VERSION,
        allowWrite: state.config.allowWrite,
        timeoutMs: state.config.timeoutMs,
        maxRows: state.config.maxRows,
        connections: listConnections().map((connection) => publicConnection(connection)),
        templates: TEMPLATES.map((entry) => ({ id: entry.id, title: entry.title, params: { ...entry.params } })),
        lastQuery: state.lastQuery,
      };
    }
    case "ping": {
      const connection = resolveConnection(payload.connection);
      const health = await ping(connection);
      return { connection: connection.id, ...health };
    }
    case "pingAll": {
      const results = [];
      for (const connection of listConnections()) {
        const health = await ping(connection);
        results.push({ id: connection.id, label: connection.label, ...health });
      }
      return { results };
    }
    case "query": {
      const connection = resolveConnection(payload.connection);
      return runFlux(connection, payload.query, { org: payload.org, maxRows: payload.maxRows });
    }
    case "buckets": {
      const connection = resolveConnection(payload.connection);
      const buckets = await listBuckets(connection);
      return { connection: connection.id, count: buckets.length, buckets };
    }
    case "schema": {
      const connection = resolveConnection(payload.connection);
      return readSchema(connection, payload);
    }
    case "write": {
      const connection = resolveConnection(payload.connection);
      return writeLines(connection, payload);
    }
    case "analyze": {
      const connection = resolveConnection(payload.connection);
      const analyzed = await analyzeFlux(connection, payload);
      return {
        ...analyzed,
        summary: analyzed.valid ? explainSummary(analyzed.stages, String(payload.query ?? "")) : "",
      };
    }
    case "template": {
      return buildTemplate(payload);
    }
    case "saveConnections": {
      const incoming = Array.isArray(payload.connections) ? payload.connections : [];
      const previous = new Map(listConnections().map((connection) => [connection.id, connection]));
      const merged = incoming.map((entry) => {
        const before = previous.get(String(entry?.id ?? "").trim());
        // An absent `token` means "the panel did not touch it": keep the stored
        // secret instead of silently clearing it. An explicit "" clears it.
        if (before !== undefined && entry?.token === undefined) return { ...entry, token: before.token };
        return entry;
      });
      const normalized = normalizeConfig({
        connections: merged,
        allowWrite: payload.allowWrite ?? state.config.allowWrite,
        timeoutMs: payload.timeoutMs ?? state.config.timeoutMs,
        maxRows: payload.maxRows ?? state.config.maxRows,
      });
      if (normalized.connections.length === 0) throw new InfluxError("keep at least one connection, or remove the plugin row instead", 400, "EMPTY_CONNECTIONS");
      for (const connection of normalized.connections) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(connection.id)) {
          throw new InfluxError(`connection id "${connection.id}" may only use letters, digits, dot, underscore and dash`, 400, "BAD_ID");
        }
      }
      const persisted = await saveConfig(ctx, {
        connections: normalized.connections.map((connection) => ({
          id: connection.id,
          label: connection.label,
          url: connection.url,
          org: connection.org,
          bucket: connection.bucket,
          token: connection.token,
          tokenEnv: connection.tokenEnv,
          default: connection.default === true,
        })),
        allowWrite: normalized.allowWrite,
        timeoutMs: normalized.timeoutMs,
        maxRows: normalized.maxRows,
      });
      // Apply immediately: a save must work whether or not the row restarts.
      state.config = normalizeConfig(persisted ?? normalized);
      return {
        saved: true,
        allowWrite: state.config.allowWrite,
        connections: listConnections().map((connection) => publicConnection(connection)),
      };
    }
    case "health": {
      return { ok: true, version: HOST_VERSION, connections: listConnections().length };
    }
    default:
      throw new InfluxError(`unknown op "${op}"`, 400, "UNKNOWN_OP");
  }
}

/* --------------------------------------------------------------------- entry */

/**
 * Register the routes and tools. Each capability is injected in its own child
 * scope so a profile without a web server or without tools still gets the other
 * half instead of failing the whole row.
 */
export function apply(ctx, config) {
  state.config = normalizeConfig(config);

  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => {
        const server = webCtx.get("webServer");
        if (server === undefined || server === null) return;
        webCtx.effect(
          () =>
            server.register({ kind: "exact", path: RPC_PATH, handler: (req, res) => handleRpc(webCtx, req, res) }),
          "dsh-influxdb: rpc route",
        );
        webCtx.effect(
          () =>
            server.register({
              kind: "exact",
              path: HEALTH_PATH,
              handler: (_req, res) =>
                sendJson(res, 200, {
                  ok: true,
                  version: HOST_VERSION,
                  connections: listConnections().length,
                  allowWrite: state.config.allowWrite,
                }),
            }),
          "dsh-influxdb: health route",
        );
      });

      ctx.inject(["tools"], (toolCtx) => {
        registerTools(toolCtx);
      });
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-influxdb: activation failed: ${String(error?.message ?? error)}`);
  }
}
