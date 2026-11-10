#!/usr/bin/env node
/**
 * dsh-influxdb MCP server (stdio).
 *
 * Exposes the same InfluxDB 2.x operations the native plugin registers, but over
 * the Model Context Protocol, so another client — including a DeepSeek Harness
 * profile whose `@deepseek-ai/dsh-mcp-client` row points here — sees them as
 * ordinary `mcp__<serverName>__<tool>` tools.
 *
 * Implemented against the MCP JSON-RPC framing directly (newline-free
 * `Content-Length` framing is not used by stdio MCP: messages are
 * newline-delimited JSON), with no third-party dependency, so it runs anywhere
 * Node runs without installing the SDK.
 *
 *   node mcp-server.mjs --config <path-to-json>
 *
 * The config file holds the same shape as the plugin row's config:
 *   { connections: [...], allowWrite, timeoutMs, maxRows }
 */

import { readFileSync } from "node:fs";

const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO = { name: "dsh-influxdb", version: "1.0.0" };

/* --------------------------------------------------------------- config */

function parseArgs(argv) {
  const out = { configPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1] !== undefined) {
      out.configPath = argv[index + 1];
      index += 1;
    }
  }
  return out;
}

function loadConfig(path) {
  // A config written on Windows often carries a UTF-8 BOM, which JSON.parse
  // rejects; strip it before parsing.
  const text = path !== ""
    ? readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    : (process.env.DSH_INFLUXDB_CONFIG ?? "{}").replace(/^\uFEFF/, "");
  const raw = JSON.parse(text);
  const connections = (Array.isArray(raw.connections) ? raw.connections : []).map((entry) => ({
    id: String(entry.id ?? "").trim(),
    label: String(entry.label ?? "").trim(),
    url: String(entry.url ?? "").replace(/\/+$/, ""),
    org: String(entry.org ?? "").trim(),
    bucket: String(entry.bucket ?? "").trim(),
    token: String(entry.token ?? "").trim(),
    tokenEnv: String(entry.tokenEnv ?? "").trim(),
    default: entry.default === true,
  })).filter((entry) => entry.id !== "" && entry.url !== "");
  if (connections.length > 0 && !connections.some((entry) => entry.default)) connections[0].default = true;
  return {
    connections,
    allowWrite: raw.allowWrite === true,
    timeoutMs: clampInt(raw.timeoutMs, 1000, 300000, 30000),
    maxRows: clampInt(raw.maxRows, 1, 2000, 200),
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

const config = loadConfig(parseArgs(process.argv.slice(2)).configPath);

/* ---------------------------------------------------------- connections */

class McpError extends Error {
  constructor(message, code = -32000) {
    super(message);
    this.code = code;
  }
}

function resolveToken(connection) {
  if (connection.tokenEnv !== "") {
    const value = process.env[connection.tokenEnv];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  if (connection.token.startsWith("env:")) {
    const value = process.env[connection.token.slice(4)];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    return "";
  }
  return connection.token;
}

function resolveConnection(id) {
  if (config.connections.length === 0) {
    throw new McpError("no InfluxDB connection configured for this MCP server");
  }
  const wanted = String(id ?? "").trim();
  if (wanted !== "") {
    const found = config.connections.find((entry) => entry.id === wanted);
    if (found === undefined) {
      throw new McpError(`unknown connection "${wanted}"; configured: ${config.connections.map((entry) => entry.id).join(", ")}`);
    }
    return found;
  }
  return config.connections.find((entry) => entry.default) ?? config.connections[0];
}

/* ------------------------------------------------------------- transport */

async function influxFetch(connection, path, options = {}) {
  const { method = "GET", body, rawBody, query, accept = "application/json", token, timeoutMs } = options;
  const url = new URL(connection.url + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const headers = { accept };
  const resolved = token === null ? null : token ?? resolveToken(connection);
  if (resolved === null) {
    // /health needs no token
  } else if (resolved === "") {
    throw new McpError(`connection "${connection.id}" has no usable token (set tokenEnv and export it)`);
  } else {
    headers.authorization = `Token ${resolved}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  if (rawBody !== undefined) headers["content-type"] = "text/plain; charset=utf-8";
  const timeout = clampInt(timeoutMs, 1000, 300000, config.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new McpError(`cannot reach ${connection.url}: ${String(error?.message ?? error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      /* keep the raw body */
    }
    throw new McpError(`InfluxDB HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  return { status: response.status, text };
}

/* ----------------------------------------------------------------- parse */

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
        } else quoted = false;
      } else current += character;
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

function coerce(value, datatype) {
  if (String(datatype ?? "") === "") return value;
  if (value === "") return null;
  const type = String(datatype);
  if (type === "double" || type === "long" || type === "unsignedLong") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") return value === "true";
  return value.length > 4000 ? value.slice(0, 4000) : value;
}

function parseFluxCsv(text, limit) {
  const tables = [];
  let columns = null;
  let datatypes = null;
  let rows = [];
  let truncated = false;
  let rowCount = 0;

  const flush = () => {
    if (columns !== null) {
      const drop = columns.length > 0 && columns[0] === "";
      tables.push({
        columns: drop ? columns.slice(1) : columns,
        rows: drop ? rows.map((row) => row.slice(1)) : rows,
      });
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
      if (parts.shift() === "datatype") datatypes = parts;
      continue;
    }
    const cells = splitCsvLine(line);
    if (columns === null) {
      columns = cells;
      continue;
    }
    if (rowCount >= limit) {
      truncated = true;
      break;
    }
    rows.push(cells.map((cell, index) => coerce(cell, datatypes?.[index])));
    rowCount += 1;
  }
  flush();
  return { tables: tables.filter((table) => table.columns !== null), rowCount, truncated };
}

/* ------------------------------------------------------------ operations */

async function ping(connection) {
  const started = Date.now();
  try {
    const result = await influxFetch(connection, "/health", { token: null, timeoutMs: 8000 });
    const body = JSON.parse(result.text);
    return { id: connection.id, ok: body.status === "pass", status: String(body.status ?? ""), version: String(body.version ?? ""), durationMs: Date.now() - started };
  } catch (error) {
    return { id: connection.id, ok: false, status: "fail", version: "", message: String(error?.message ?? error), durationMs: Date.now() - started };
  }
}

async function runQuery(connection, args) {
  const flux = String(args.query ?? "");
  if (flux.trim() === "") throw new McpError("query is empty");
  const org = String(args.org ?? "").trim() || connection.org;
  if (org === "") throw new McpError(`connection "${connection.id}" has no org`);
  const limit = clampInt(args.maxRows, 1, 2000, config.maxRows);
  const started = Date.now();
  const result = await influxFetch(connection, "/api/v2/query", {
    method: "POST",
    query: { org },
    accept: "application/csv",
    body: {
      query: flux,
      type: "flux",
      dialect: { header: true, delimiter: ",", commentPrefix: "#", annotations: ["datatype", "group", "default"] },
    },
  });
  const parsed = parseFluxCsv(result.text, limit);
  return {
    connection: connection.id,
    org,
    durationMs: Date.now() - started,
    rowCount: parsed.rowCount,
    rowLimit: limit,
    truncated: parsed.truncated,
    tables: parsed.tables.map((table) => ({ columns: table.columns, rows: table.rows })),
  };
}

async function listBuckets(connection) {
  // InfluxDB 2.1 caps limit at 100, so page through short requests.
  const buckets = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const result = await influxFetch(connection, "/api/v2/buckets", {
      query: { org: connection.org === "" ? undefined : connection.org, limit: 100, offset },
    });
    const page = JSON.parse(result.text);
    const items = Array.isArray(page.buckets) ? page.buckets : [];
    buckets.push(...items);
    if (items.length < 100) break;
  }
  return {
    connection: connection.id,
    buckets: buckets.map((bucket) => {
      const seconds = Number((Array.isArray(bucket.retentionRules) ? bucket.retentionRules[0] : undefined)?.everySeconds ?? 0);
      return { name: String(bucket.name ?? ""), id: String(bucket.id ?? ""), type: String(bucket.type ?? ""), retention: seconds > 0 ? Math.round(seconds / 86400) + "d" : "infinite" };
    }),
  };
}

function fluxString(value) {
  return '"' + String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function readSchema(connection, args) {
  const action = String(args.action ?? "measurements");
  const bucket = String(args.bucket ?? "").trim() || connection.bucket;
  if (bucket === "") throw new McpError("a bucket is required");
  let flux;
  if (action === "buckets") {
    flux = 'buckets() |> keep(columns: ["name", "id", "retentionPolicy", "retentionPeriod"])';
  } else if (action === "measurements") {
    flux = `import "influxdata/influxdb/schema"\n\nschema.measurements(bucket: ${fluxString(bucket)})`;
  } else if (action === "fields") {
    if (String(args.measurement ?? "").trim() === "") throw new McpError("measurement is required for fields");
    flux = `import "influxdata/influxdb/schema"\n\nschema.measurementFieldKeys(bucket: ${fluxString(bucket)}, measurement: ${fluxString(args.measurement)})`;
  } else if (action === "tags") {
    if (String(args.measurement ?? "").trim() === "") throw new McpError("measurement is required for tags");
    flux = `import "influxdata/influxdb/schema"\n\nschema.measurementTagKeys(bucket: ${fluxString(bucket)}, measurement: ${fluxString(args.measurement)})`;
  } else if (action === "tagValues") {
    if (String(args.tag ?? "").trim() === "") throw new McpError("tag is required for tagValues");
    flux = `import "influxdata/influxdb/schema"\n\nschema.tagValues(bucket: ${fluxString(bucket)}, tag: ${fluxString(args.tag)})`;
  } else {
    throw new McpError(`unknown action "${action}"`);
  }
  const result = await runQuery(connection, { query: flux, org: args.org, maxRows: 500 });
  const values = [];
  for (const table of result.tables) {
    const index = table.columns.indexOf("_value");
    if (index < 0) continue;
    for (const row of table.rows) if (row[index] !== null && row[index] !== undefined) values.push(String(row[index]));
  }
  return { connection: connection.id, bucket, action, valueCount: values.length, values };
}

async function writeLines(connection, args) {
  if (!config.allowWrite) {
    throw new McpError("writing is disabled: set allowWrite: true in the config passed with --config");
  }
  const bucket = String(args.bucket ?? "").trim() || connection.bucket;
  if (bucket === "") throw new McpError("a bucket is required to write");
  const org = String(args.org ?? "").trim() || connection.org;
  if (org === "") throw new McpError("an org is required to write");
  const lines = String(args.lines ?? "").trim();
  if (lines === "") throw new McpError("lines is empty");
  const precision = ["ns", "us", "ms", "s"].includes(String(args.precision ?? "")) ? String(args.precision) : "ns";
  const result = await influxFetch(connection, "/api/v2/write", {
    method: "POST",
    query: { org, bucket, precision },
    rawBody: lines,
  });
  return { connection: connection.id, org, bucket, precision, accepted: true, status: result.status, lineCount: lines.split(/\r?\n/).filter((line) => line.trim() !== "").length };
}

async function analyze(connection, args) {
  const flux = String(args.query ?? "");
  if (flux.trim() === "") throw new McpError("query is empty");
  const org = String(args.org ?? "").trim() || connection.org;
  try {
    const result = await influxFetch(connection, "/api/v2/query/analyze", { method: "POST", query: { org }, body: { query: flux, type: "flux" } });
    const ast = JSON.parse(result.text);
    const stages = [];
    const walk = (node) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node.type === "PipeExpression" || node.type === "CallExpression") {
        const callee = node.callee ?? node.call?.callee;
        if (callee?.type === "Identifier") stages.push(callee.name);
      }
      for (const value of Object.values(node)) walk(value);
    };
    walk(ast);
    return { valid: true, connection: connection.id, stages };
  } catch (error) {
    return { valid: false, connection: connection.id, stages: [], error: String(error?.message ?? error) };
  }
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: "influx_query",
    description:
      "Run a Flux query against InfluxDB 2.x and return the result tables. Rows are capped at maxRows and truncation is flagged. Use this for any time-series read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Complete Flux script, including from() and range()." },
        connection: { type: "string", description: "Connection id; defaults to the default connection." },
        org: { type: "string", description: "Org override." },
        maxRows: { type: "integer", minimum: 1, maximum: 2000, description: "Row cap for this call." },
      },
      required: ["query"],
    },
    handler: async (args) => runQuery(resolveConnection(args.connection), args),
  },
  {
    name: "influx_schema",
    description:
      "Read InfluxDB schema metadata: bucket list, measurement names, a measurement's field keys or tag keys, or one tag's values. Call it before writing a query so names are real.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["buckets", "measurements", "fields", "tags", "tagValues"] },
        connection: { type: "string" },
        bucket: { type: "string" },
        measurement: { type: "string" },
        tag: { type: "string" },
      },
      required: ["action"],
    },
    handler: async (args) => readSchema(resolveConnection(args.connection), args),
  },
  {
    name: "influx_buckets",
    description: "List the buckets of an InfluxDB org with their id, type and retention.",
    inputSchema: { type: "object", properties: { connection: { type: "string" } } },
    handler: async (args) => listBuckets(resolveConnection(args.connection)),
  },
  {
    name: "influx_connections",
    description: "List the InfluxDB connections this MCP server is configured with and optionally check each one's health.",
    inputSchema: { type: "object", properties: { ping: { type: "boolean" }, connection: { type: "string" } } },
    handler: async (args) => {
      const wanted = String(args.connection ?? "").trim();
      const list = config.connections.filter((entry) => wanted === "" || entry.id === wanted);
      const out = [];
      for (const connection of list) {
        const hasToken = resolveToken(connection) !== "";
        const row = { id: connection.id, label: connection.label, url: connection.url, org: connection.org, bucket: connection.bucket, default: connection.default === true, hasToken, tokenFrom: connection.tokenEnv !== "" ? "env" : connection.token !== "" ? "config" : "none" };
        if (args.ping === true) Object.assign(row, await ping(connection));
        out.push(row);
      }
      return { count: out.length, allowWrite: config.allowWrite, connections: out };
    },
  },
  {
    name: "influx_write",
    description: "Write InfluxDB line protocol. Refused unless allowWrite is true in this server's config.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "string", description: "Line protocol, one point per line." },
        connection: { type: "string" },
        bucket: { type: "string" },
        org: { type: "string" },
        precision: { type: "string", enum: ["ns", "us", "ms", "s"] },
      },
      required: ["lines"],
    },
    handler: async (args) => writeLines(resolveConnection(args.connection), args),
  },
  {
    name: "influx_flux_validate",
    description: "Parse a Flux script server-side and report whether it is valid plus its ordered pipeline stages.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, connection: { type: "string" }, org: { type: "string" } },
      required: ["query"],
    },
    handler: async (args) => analyze(resolveConnection(args.connection), args),
  },
];

/* -------------------------------------------------------------- JSON-RPC */

/** Reply builders: pure, so the same handler serves the stdio loop and tests. */
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    return ok(id, {
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return fail(id, -32602, `unknown tool "${name}"`);
    }
    try {
      const value = await tool.handler(params?.arguments ?? {});
      return ok(id, textResult(value));
    } catch (error) {
      return ok(id, { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true });
    }
  }
  return fail(id, -32601, `method not found: ${method}`);
}

/** One JSON-RPC line in, the reply (if any) out. Exported for tests. */
export async function handleLine(line) {
  const text = String(line ?? "").trim();
  if (text === "") return null;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }
  return await handle(message);
}

export { TOOLS, PROTOCOL_VERSION, SERVER_INFO };

function startStdioServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line).then((reply) => {
        if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
      });
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const invokedDirectly = process.argv[1] !== undefined && /mcp-server\.mjs$/.test(process.argv[1]);
if (invokedDirectly) startStdioServer();
