# @super-ding/dsh-influxdb

InfluxDB 2.x 插件（DeepSeek Harness bundle）：让 Agent 与侧边面板都能查询 InfluxDB、查看 schema、编写 Flux、管理连接。

支持版本：**InfluxDB 2.x**（Flux + token）。1.8 与 3.x 使用不同的查询接口与鉴权，不在本插件范围内。

## 是插件工具，不是 MCP 服务器（默认）

装上本 bundle 后，Agent 在会话里**直接**就能用 `influx_query`、`influx_schema` 等原生工具，无需任何 MCP 配置——这是推荐用法。

插件默认**不是** MCP 服务器。`@deepseek-ai/dsh-mcp-client` 的作用是让 DSH 去连**外部** MCP 服务器；本插件注册的是原生工具，没有对外暴露 MCP endpoint。所以它不会以 `mcp__xxx__yyy` 的名字出现，除非你按下一节启用随包附带的 MCP server。

## 可选：以 MCP 服务器方式使用

包里附带 `mcp-server.mjs`——一个零依赖的 stdio MCP 服务器，把同一套 InfluxDB 操作以标准 MCP 工具暴露。适用于：其他 MCP 客户端（Claude Code、Codex、其他 DSH profile）需要访问同一个 InfluxDB。

1. 准备配置文件（可参考 `mcp-config.example.json`），结构与插件行 config 相同。
2. 在你的 profile 的 `cordis.patch.yml` 里加一行 MCP 客户端：

```yaml
- id: influxdb-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: influxdb
    transport: stdio
    command: node
    args:
      - "D:/path/to/dsh-influxdb/mcp-server.mjs"
      - "--config"
      - "D:/path/to/dsh-influxdb/mcp-config.json"
    env:
      INFLUX_TOKEN: !!js process.env.INFLUX_TOKEN
```

3. 重载后工具会以 `mcp__influxdb__influx_query` 等名字出现。

该 MCP 服务器暴露的 6 个工具：`influx_query`、`influx_schema`、`influx_buckets`、`influx_connections`、`influx_write`、`influx_flux_validate`。

注意：stdio MCP 是**独立进程**，读的是 `--config` 指向的文件，**不会**自动继承面板里保存的连接。两处需分别配置。

## 能力

### Agent 工具

| 工具 | 作用 |
| --- | --- |
| `influx_connections` | 列出连接（url / org / bucket / token 来源），`ping: true` 时测 `/health` |
| `influx_query` | 执行 Flux，返回 JSON 表格（列名 + 行数组），带行数上限与 `truncated` 标记 |
| `influx_schema` | 读 schema：`buckets` / `measurements` / `fields` / `tags` / `tagValues` |
| `influx_buckets` | 列 bucket 及保留策略 |
| `influx_write` | 写 line protocol（默认**关闭**，需 `allowWrite: true`） |
| `influx_flux` | Flux 编写辅助：`validate` 服务端校验、`explain` 管线解释、`template` 模板、`params` 模板清单 |

### 侧边面板

侧边栏 **InfluxDB** 图标 → 主面板：

- **查询**：连接选择、Flux 编辑器（Tab 缩进、Ctrl/Cmd+Enter 运行）、模板插入、服务端校验、结果表格。
- **连接**：新增 / 编辑 / 删除 / 设默认，`tokenEnv` 优先于明文 token，`allowWrite` 开关，保存后立即生效。

## 配置

插件行写在 profile 的 `cordis.patch.yml`（安装 bundle 时自动插入默认行）：

```yaml
- id: dsh-influxdb
  name: "@super-ding/dsh-influxdb"
  config:
    allowWrite: false        # 是否允许 influx_write 与面板写入
    timeoutMs: 30000         # 单次请求超时
    maxRows: 200             # 默认返回行数上限（1-2000）
    connections:
      - id: prod             # 连接 id，工具里用 connection 参数指定
        label: 生产 InfluxDB
        url: http://127.0.0.1:8086
        org: my-org
        bucket: metrics      # 默认 bucket，查询/schema/写入的缺省值
        tokenEnv: INFLUX_TOKEN   # 推荐：token 只放环境变量
        # token: "xxxx"      # 也可直接写，但不推荐
        default: true        # 工具的默认连接
      - id: staging
        url: http://10.0.0.12:8086
        org: my-org
        bucket: metrics_dev
        token: "staging-token"
```

`token` 字段也接受 `env:INFLUX_TOKEN` 或 `${INFLUX_TOKEN}` 写法；`tokenEnv` 与 `token` 同时存在时**环境变量优先**。

面板里保存连接会通过 profile 的 `configEditor` 写回上面这一行的 `config`，因此编辑结果与手改 YAML 等价。

### Token 权限

建议用最小权限 token：

```bash
influx auth create --org my-org --read-bucket <id> [--write-bucket <id>]
```

只读场景不要授予 write 权限——即使插件里打开了 `allowWrite`，InfluxDB 仍会拒绝写入。

## 安全边界

- 写能力默认关闭；关闭时 `influx_write` 直接返回 `WRITE_DISABLED`，不会发出请求。
- 面板 RPC 路由 `POST /influxdb/rpc` 只接受 loopback Origin，非本机来源返回 403。
- 查询结果按 `maxRows` 截断并显式标注 `truncated`，单个单元格最长 4000 字符，避免撑爆上下文。
- 插件不会把 token 写进日志或工具结果；`influx_connections` 只返回 `***` 尾号和来源（env/config）。

## 安装

从 npm 安装（推荐）：

```bash
dsh plugin --profile desktop add @super-ding/dsh-influxdb
```

从 GitHub 安装（未发 npm 时的等价方式）：

```bash
dsh plugin --profile desktop add github:super-ding/dsh-influxdb
```

本地开发时也可直接挂载源码目录：

```bash
dsh plugin --profile desktop add D:\Deepseek\dsh\plugins\dsh-influxdb
```

## 开发

```bash
cd plugins/dsh-influxdb
node --check index.js && node --check client.js && node --check mcp-server.mjs
node test-offline.mjs   # Host 半：工具、CSV 解析、RPC、写开关、token 保留
node test-mcp.mjs       # MCP 服务器：协议、工具、错误分支
```

## 已知限制

- 仅支持 2.x 的 `/api/v2/*`；1.8（InfluxQL）与 3.x（SQL / InfluxQL）协议未实现。
- 不支持 InfluxDB Cloud 的目录级多 org 切换：一个连接对应一个 org，跨 org 用多个连接。
- 面板不做图表可视化，只给出表格；图表需求可把结果交给其他可视化工具。
