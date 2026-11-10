/**
 * Offline check for mcp-server.mjs.
 *
 * The protocol loop is exercised in-process (the sandbox blocks a Node parent
 * from spawning a piped child here), and the real stdio wiring is verified
 * separately by piping requests through the shell.
 *
 *   node test-mcp.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "mcp-test-token-9876543210";

const csv = [
  "#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string",
  "#group,false,false,true,true,true,false,true,true",
  "#default,_result,,,,,,,,",
  ",result,table,_start,_stop,_time,_value,_field,_measurement",
  ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:10:00Z,11.5,usage,cpu",
  ",,0,2026-11-10T00:00:00Z,2026-11-10T01:00:00Z,2026-11-10T00:20:00Z,12.5,usage,cpu",
].join("\n");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "pass", version: "2.7.11" }));
      return;
    }
    if (req.headers.authorization !== `Token ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unauthorized", message: "unauthorized access" }));
      return;
    }
    if (url.pathname === "/api/v2/buckets") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ buckets: [{ id: "b1", name: "metrics", type: "user", retentionRules: [{ everySeconds: 86400 }] }] }));
      return;
    }
    if (url.pathname === "/api/v2/query/analyze") {
      const stages = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\(/g)].map((match) => match[1]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "File", body: stages.map((stage) => ({ type: "PipeExpression", call: { callee: { type: "Identifier", name: stage } } })) }));
      return;
    }
    if (url.pathname === "/api/v2/query") {
      res.writeHead(200, { "content-type": "application/csv" });
      res.end(csv);
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

const dir = mkdtempSync(join(tmpdir(), "dsh-influxdb-mcp-"));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    connections: [{ id: "local", label: "Local", url: `http://127.0.0.1:${port}`, org: "org1", bucket: "metrics", tokenEnv: "MCP_TEST_TOKEN", default: true }],
    allowWrite: false,
    timeoutMs: 10000,
    maxRows: 1,
  }),
);

process.env.MCP_TEST_TOKEN = TOKEN;
process.env.DSH_INFLUXDB_CONFIG_PATH = configPath;

// The module reads --config at import time, so set argv before importing. argv[1]
// must not look like the server itself, or the import starts the stdio loop.
process.argv = [process.argv[0], "test-mcp.mjs", "--config", configPath];
const { handleLine } = await import("./mcp-server.mjs");

const call = async (method, params) => {
  const reply = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return reply;
};

const init = await call("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "0" } });
assert.equal(init.result.serverInfo.name, "dsh-influxdb");
assert.ok(init.result.capabilities.tools, "declares tools capability");
console.log("initialize ok");

const list = await call("tools/list", {});
const names = list.result.tools.map((tool) => tool.name);
assert.equal(names.length, 6);
for (const required of ["influx_query", "influx_write", "influx_schema", "influx_buckets", "influx_connections", "influx_flux_validate"]) {
  assert.ok(names.includes(required), `tool ${required} exposed`);
}
console.log("tools/list ok: " + names.join(", "));

const queried = await call("tools/call", { name: "influx_query", arguments: { query: 'from(bucket: "metrics") |> range(start: -1h)' } });
const payload = JSON.parse(queried.result.content[0].text);
assert.equal(payload.rowCount, 1, "row cap applied");
assert.equal(payload.truncated, true);
assert.deepEqual(payload.tables[0].columns.slice(0, 3), ["result", "table", "_start"]);
console.log("tools/call influx_query ok");

const buckets = JSON.parse((await call("tools/call", { name: "influx_buckets", arguments: {} })).result.content[0].text);
assert.equal(buckets.buckets[0].retention, "1d");
console.log("influx_buckets ok");

const schema = JSON.parse((await call("tools/call", { name: "influx_schema", arguments: { action: "measurements" } })).result.content[0].text);
assert.equal(schema.action, "measurements");
console.log("influx_schema ok");

const validated = JSON.parse(
  (await call("tools/call", { name: "influx_flux_validate", arguments: { query: 'from(bucket: "m") |> range(start: -1h) |> filter(fn: (r) => r._field == "x")' } })).result.content[0].text,
);
assert.equal(validated.valid, true);
assert.ok(validated.stages.length >= 3);
console.log("influx_flux_validate ok");

const blocked = await call("tools/call", { name: "influx_write", arguments: { lines: "cpu usage=1" } });
assert.equal(blocked.result.isError, true);
assert.match(blocked.result.content[0].text, /writing is disabled/);
console.log("write guard ok");

const pinged = JSON.parse((await call("tools/call", { name: "influx_connections", arguments: { ping: true } })).result.content[0].text);
assert.equal(pinged.connections[0].ok, true);
assert.equal(pinged.connections[0].tokenFrom, "env");
console.log("influx_connections ok");

const unknown = await call("tools/call", { name: "nope", arguments: {} });
assert.equal(unknown.error.code, -32602);
console.log("unknown tool rejected ok");

const bad = await handleLine("{not json");
assert.equal(bad.error.code, -32700);
console.log("parse error handled ok");

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("\nall MCP checks passed");
