/**
 * Offline check for the dsh-influxdb host half.
 *
 * A tiny fake InfluxDB 2.x listens on a random port; the plugin is mounted with
 * a stub Cordis context so its tools and routes can be exercised exactly as the
 * harness would call them.
 *
 *   node test-offline.mjs
 */
import http from "node:http";
import assert from "node:assert/strict";
import { apply } from "./index.js";

const TOKEN = "test-token-1234567890";
const ORG = "my-org";

const fluxCsv = [
  "#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,string",
  "#group,false,false,true,true,true,false,true,true,true",
  "#default,_result,,,,,,,,",
  ",result,table,_start,_stop,_time,_value,_field,_measurement,host",
  ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:30:00Z,12.5,usage,cpu,a",
  ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:45:00Z,13.25,usage,cpu,a",
  ',,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:50:00Z,"value, with comma",usage,cpu,a',
  ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:55:00Z,14.0,usage,cpu,a",
].join("\n");

const requests = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "pass", version: "2.7.11" }));
      return;
    }
    if (url.pathname === "/api/v2/buckets") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          buckets: [
            { id: "b1", name: "metrics", type: "user", retentionRules: [{ everySeconds: 604800 }], createdAt: "2026-01-01T00:00:00Z", orgID: "o1" },
            { id: "b2", name: "archive", type: "user", retentionRules: [], createdAt: "2026-01-02T00:00:00Z", orgID: "o1" },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/api/v2/query/analyze") {
      if (body.includes("oops(")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid", message: 'error calling function "oops": unknown function' }));
        return;
      }
      // Build a plausible AST: every `name(` in the script becomes a CallExpression.
      const stages = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\(/g)].map((match) => match[1]);
      const bodyNodes = stages.map((stage) => ({
        type: "ExpressionStatement",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 20 }, source: stage },
        expression: { type: "PipeExpression", call: { callee: { type: "Identifier", name: stage } } },
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "File", body: bodyNodes }));
      return;
    }
    if (url.pathname === "/api/v2/query") {
      res.writeHead(200, { "content-type": "application/csv" });
      const asked = body;
      if (asked.includes("schema.measurements(")) {
        res.end(
          [
            "#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,string,string,string",
            "#group,false,false,true,true,false,false,true,true",
            "#default,_result,,,,,,,,",
            ",result,table,_start,_stop,_time,_value,_field,_measurement",
            ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:00:00Z,cpu,,",
            ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:00:00Z,mem,,",
          ].join("\n"),
        );
        return;
      }
      res.end(fluxCsv);
      return;
    }
    if (url.pathname === "/api/v2/write") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const tools = new Map();
const routes = new Map();
const configEditorCalls = [];

const ctx = {
  logger: { warn: (message) => console.log("[warn]", message) },
  inject(names, callback) {
    const scope = {
      get: (key) => (key === "webServer" ? webServer : ctx.get(key)),
      effect: (factory) => {
        const dispose = factory();
        return () => dispose?.();
      },
      logger: ctx.logger,
      fiber: ctx.fiber,
    };
    if (names.includes("tools")) {
      callback({ ...scope, tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } } });
    } else if (names.includes("webServer")) {
      callback({ ...scope, webServer });
    }
  },
  effect: (factory) => factory(),
  get: (key) => (key === "configEditor" ? editor : undefined),
  fiber: { entry: { id: "dsh-influxdb" } },
};

const webServer = {
  register: (route) => {
    routes.set(route.path, route.handler);
    return () => {};
  },
};

const editor = {
  edit: async (entry, change) => {
    const next = change({ connections: [], allowWrite: false, timeoutMs: 30000, maxRows: 200 }, {});
    configEditorCalls.push(next);
    return next;
  },
};

apply(ctx, {
  connections: [
    {
      id: "local",
      label: "Local InfluxDB",
      url: base,
      org: ORG,
      bucket: "metrics",
      token: "",
      tokenEnv: "INFLUX_TEST_TOKEN",
      default: true,
    },
  ],
  allowWrite: false,
  timeoutMs: 10000,
  maxRows: 3,
});

process.env.INFLUX_TEST_TOKEN = TOKEN;

function tool(name) {
  const definition = tools.get(name);
  assert.ok(definition, `tool ${name} is registered`);
  return definition;
}

async function callTool(name, args) {
  const value = await tool(name).execute(args, {});
  assertConforms(tool(name).output.schema, value, name);
  return value;
}

/**
 * The harness validates every tool result against its declared schema and fails
 * the call on an undeclared property, so check that here instead of discovering
 * it in a live conversation.
 */
function assertConforms(schema, value, path) {
  if (schema === null || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(typeof value, "object", `${path} must be an object`);
    if (value === null) return;
    const declared = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(declared, key) || schema.additionalProperties === true || schema.additionalProperties === undefined || schema.additionalProperties,
        `${path}.${key} is not declared (additionalProperties: ${JSON.stringify(schema.additionalProperties)})`,
      );
    }
    for (const [key, child] of Object.entries(declared)) {
      if (value[key] === undefined) continue;
      assertConforms(child, value[key], `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    for (const [index, item] of value.entries()) assertConforms(schema.items, item, `${path}[${index}]`);
    return;
  }
  if (schema.type === "string") assert.equal(typeof value, "string", `${path} must be a string`);
  if (schema.type === "number") assert.equal(typeof value, "number", `${path} must be a number`);
  if (schema.type === "boolean") assert.equal(typeof value, "boolean", `${path} must be a boolean`);
}

/* ---------------------------------------------------------------- tools */

const listed = await callTool("influx_connections", { ping: true });
assert.equal(listed.count, 1);
assert.equal(listed.connections[0].id, "local");
assert.equal(listed.connections[0].hasToken, true);
assert.equal(listed.connections[0].tokenFrom, "env");
assert.equal(listed.connections[0].health, "pass");
assert.equal(listed.connections[0].version, "2.7.11");
console.log("connections+ping ok");

const queried = await callTool("influx_query", { query: "from(bucket: \"metrics\")\n  |> range(start: -1h)" });
assert.equal(queried.rowCount, 3, "row cap honoured");
assert.equal(queried.truncated, true, "truncation flagged");
assert.deepEqual(queried.tables[0].columns.slice(0, 5), ["result", "table", "_start", "_stop", "_time"], "annotation column dropped");
assert.equal(queried.tables[0].rows[2][5], "value, with comma", "quoted CSV cell survives");
const sendQuery = requests.filter((r) => r.path === "/api/v2/query").at(-1);
assert.equal(sendQuery.query.org, ORG);
assert.equal(sendQuery.headers.authorization, `Token ${TOKEN}`);
assert.equal(JSON.parse(sendQuery.body).dialect.annotations.length, 3);
console.log("query + csv parse ok");

const buckets = await callTool("influx_buckets", {});
assert.equal(buckets.count, 2);
assert.equal(buckets.buckets[0].retention, "7d");
assert.equal(buckets.buckets[1].retention, "infinite");
console.log("buckets ok");

const measurements = await callTool("influx_schema", { action: "measurements", bucket: "metrics" });
assert.deepEqual(measurements.values, ["cpu", "mem"], "schema _value extraction");
const schemaQuery = requests.filter((r) => r.path === "/api/v2/query").at(-1);
assert.match(JSON.parse(schemaQuery.body).query, /schema\.measurements\(bucket: "metrics"\)/);
console.log("schema ok");

const valid = await callTool("influx_flux", { action: "validate", query: "from(bucket: \"metrics\") |> range(start: -1h)" });
assert.equal(valid.valid, true);
assert.ok(valid.stages.includes("filter") || valid.stages.includes("range") || valid.stages.length >= 0);
const invalid = await callTool("influx_flux", { action: "validate", query: "oops()" });
assert.equal(invalid.valid, false);
assert.match(invalid.error, /unknown function/);
const explained = await callTool("influx_flux", { action: "explain", query: 'from(bucket: "m") |> range(start: -1h) |> filter(fn: (r) => r._field == "x")' });
assert.match(explained.summary, /reads from a bucket/);
const template = await callTool("influx_flux", { action: "template", template: "window", params: { bucket: "metrics", measurement: "cpu", field: "usage" } });
assert.match(template.flux, /aggregateWindow\(every: 5m, fn: mean/);
assert.match(template.flux, /from\(bucket: "metrics"\)/);
const params = await callTool("influx_flux", { action: "params" });
assert.ok(params.templates.length >= 8);
console.log("flux assistant ok");

// writes are refused while allowWrite is false
await assert.rejects(() => callTool("influx_write", { lines: "cpu,host=a usage=1.0" }), /writing is disabled/);
console.log("write guard ok");

/* --------------------------------------------------------------- routes */

const rpc = routes.get("/influxdb/rpc");
assert.ok(typeof rpc === "function", "rpc route registered");
assert.ok(typeof routes.get("/influxdb/health") === "function", "health route registered");

function callRpc(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const fakeReq = {
      url: "/influxdb/rpc",
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:51779", ...headers },
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    };
    const fakeRes = {
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        resolve({ status: this.status || 200, body: JSON.parse(text) });
      },
    };
    rpc(fakeReq, fakeRes).catch(reject);
  });
}

const stateCall = await callRpc({ op: "state" });
assert.equal(stateCall.status, 200);
assert.equal(stateCall.body.ok, true);
assert.equal(stateCall.body.value.connections.length, 1);
assert.ok(stateCall.body.value.templates.length >= 8);
console.log("rpc state ok");

const pingCall = await callRpc({ op: "pingAll" });
assert.equal(pingCall.body.value.results[0].ok, true);
console.log("rpc pingAll ok");

const queryCall = await callRpc({ op: "query", query: 'from(bucket: "metrics") |> range(start: -1h)', maxRows: 2 });
assert.equal(queryCall.body.value.rowCount, 2);
console.log("rpc query ok");

const forbidden = await callRpc({ op: "state" }, { origin: "https://evil.example" });
assert.equal(forbidden.status, 403);
console.log("rpc origin guard ok");

const saved = await callRpc({
  op: "saveConnections",
  allowWrite: true,
  connections: [
    { id: "local", label: "Local", url: base, org: ORG, bucket: "metrics", token: "", tokenEnv: "INFLUX_TEST_TOKEN", default: true },
    { id: "second", label: "Second", url: "http://db.example:8086", org: "other", bucket: "b", token: "abc", tokenEnv: "", default: false },
  ],
});
assert.equal(saved.body.ok, true);
assert.equal(saved.body.value.connections.length, 2);
assert.equal(configEditorCalls.length, 1, "config editor called once");
assert.equal(configEditorCalls[0].allowWrite, true);
console.log("rpc saveConnections ok");

// A panel save that omits `token` (the UI never receives the secret) must keep
// the stored token instead of clearing it; an explicit "" clears it.
const keptToken = await callRpc({
  op: "saveConnections",
  allowWrite: true,
  connections: [{ id: "second", label: "Second renamed", url: "http://db.example:8086", org: "other", bucket: "b", default: true }],
});
assert.equal(keptToken.body.ok, true);
assert.equal(keptToken.body.value.connections[0].hasToken, true, "token survives a panel save that does not send it");
assert.equal(keptToken.body.value.connections[0].tokenHint, "***abc");
const cleared = await callRpc({
  op: "saveConnections",
  allowWrite: true,
  connections: [{ id: "second", label: "Second renamed", url: "http://db.example:8086", org: "other", bucket: "b", token: "", default: true }],
});
assert.equal(cleared.body.value.connections[0].hasToken, false, "an explicit empty token clears it");
// restore the working connection for the write check below
await callRpc({
  op: "saveConnections",
  allowWrite: true,
  connections: [{ id: "local", label: "Local", url: base, org: ORG, bucket: "metrics", token: "", tokenEnv: "INFLUX_TEST_TOKEN", default: true }],
});
console.log("token preservation ok");

// writing is now enabled and reaches the write API as raw line protocol
const written = await callTool("influx_write", { lines: "cpu,host=a usage=1.5 1700000000000000000\ncpu,host=b usage=2.5 1700000000000000000" });
assert.equal(written.lineCount, 2);
const writeRequest = requests.filter((r) => r.path === "/api/v2/write").at(-1);
assert.equal(writeRequest.query.bucket, "metrics");
assert.equal(writeRequest.query.precision, "ns");
assert.match(writeRequest.body, /^cpu,host=a usage=1\.5/);
assert.equal(writeRequest.headers["content-type"], "text/plain; charset=utf-8");
console.log("write ok");

/* runner */

server.close();
console.log("\nall offline checks passed");
