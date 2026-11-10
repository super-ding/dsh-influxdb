/**
 * @super-ding/dsh-influxdb - Client half.
 *
 * One sidebar entry and one main panel:
 *
 *   - connections: pick the active one, see its /health status, edit the whole
 *     list (add / change / remove / mark default) and save it back through the
 *     Host's config editor.
 *   - Flux: a real editor (monospace, tab-indented, Ctrl/Cmd+Enter runs),
 *     template insertion, server-side validation and the result tables.
 *
 * Everything runs through `POST /influxdb/rpc` on the Host half, which is the
 * same operation layer the agent tools use.
 */
(() => {
  try {
    window.__ModuleLoader__.load({
      id: "@super-ding/dsh-influxdb",
      factory: (require) => {
        const React = require("react");
        const h = React.createElement;
        const NS = "influxdb";

        const ZH = {
          "meta.title": "InfluxDB",
          "meta.description": "连接 InfluxDB 2.x 数据库：执行 Flux 查询、查看 schema、编写与保存连接。",
          "panel.title": "InfluxDB",
          "panel.subtitle": "Flux 查询与连接管理",
          "tab.query": "查询",
          "tab.connections": "连接",
          "conn.none": "还没有配置连接。切到「连接」页新增一个。",
          "conn.select": "连接",
          "conn.default": "默认",
          "conn.health": "状态",
          "conn.online": "在线",
          "conn.offline": "离线",
          "conn.unknown": "未检测",
          "conn.check": "检测",
          "conn.checkAll": "检测全部",
          "conn.add": "新增连接",
          "conn.remove": "删除",
          "conn.save": "保存",
          "conn.saved": "已保存",
          "conn.saveFailed": "保存失败：",
          "conn.id": "ID",
          "conn.label": "名称",
          "conn.url": "地址",
          "conn.org": "Org",
          "conn.bucket": "默认 Bucket",
          "conn.token": "Token",
          "conn.tokenEnv": "Token 环境变量",
          "conn.tokenHint": "环境变量优先；留空则用上面的 token",
          "conn.setDefault": "设为默认",
          "conn.allowWrite": "允许写入（influx_write 工具）",
          "conn.keepOne": "至少要保留一个连接。",
          "conn.invalidUrl": "地址必须以 http:// 或 https:// 开头",
          "query.placeholder": "from(bucket: \"my-bucket\")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == \"cpu\")",
          "query.run": "运行",
          "query.running": "执行中…",
          "query.validate": "校验",
          "query.template": "模板",
          "query.insertTemplate": "插入模板",
          "query.clear": "清空",
          "query.result": "结果",
          "query.empty": "还没有结果。写一段 Flux，按 Ctrl/Cmd+Enter 运行。",
          "query.rows": "行",
          "query.tables": "表",
          "query.ms": "毫秒",
          "query.truncated": "结果已按行数上限截断",
          "query.valid": "Flux 语法通过",
          "query.invalid": "Flux 校验未通过：",
          "query.failed": "查询失败：",
          "query.analyzing": "校验中…",
          "query.showing": "显示前 {n} 行",
          "write.disabled": "写入已关闭（连接页可开启）",
          "tpl.raw": "基础查询",
          "tpl.window": "窗口聚合",
          "tpl.latest": "最新值",
          "tpl.rate": "变化率",
          "tpl.pivot": "字段转列",
          "tpl.groupcount": "分组计数",
          "tpl.topn": "TopN",
          "tpl.join": "双指标 join",
          "tpl.threshold": "阈值状态",
          "tpl.downsample": "降采样",
        };

        const EN = {
          "meta.title": "InfluxDB",
          "meta.description": "Connect to an InfluxDB 2.x database: run Flux queries, inspect schemas, and author connections.",
          "panel.title": "InfluxDB",
          "panel.subtitle": "Flux queries and connections",
          "tab.query": "Query",
          "tab.connections": "Connections",
          "conn.none": "No connection yet. Add one on the Connections tab.",
          "conn.select": "Connection",
          "conn.default": "default",
          "conn.health": "Status",
          "conn.online": "online",
          "conn.offline": "offline",
          "conn.unknown": "unchecked",
          "conn.check": "Check",
          "conn.checkAll": "Check all",
          "conn.add": "Add connection",
          "conn.remove": "Remove",
          "conn.save": "Save",
          "conn.saved": "Saved",
          "conn.saveFailed": "Save failed: ",
          "conn.id": "ID",
          "conn.label": "Name",
          "conn.url": "URL",
          "conn.org": "Org",
          "conn.bucket": "Default bucket",
          "conn.token": "Token",
          "conn.tokenEnv": "Token env var",
          "conn.tokenHint": "The env var wins when set; otherwise the token above is used",
          "conn.setDefault": "Set default",
          "conn.allowWrite": "Allow writes (influx_write tool)",
          "conn.keepOne": "Keep at least one connection.",
          "conn.invalidUrl": "The URL must start with http:// or https://",
          "query.placeholder": "from(bucket: \"my-bucket\")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == \"cpu\")",
          "query.run": "Run",
          "query.running": "Running…",
          "query.validate": "Validate",
          "query.template": "Template",
          "query.insertTemplate": "Insert",
          "query.clear": "Clear",
          "query.result": "Result",
          "query.empty": "No result yet. Write Flux and press Ctrl/Cmd+Enter.",
          "query.rows": "rows",
          "query.tables": "tables",
          "query.ms": "ms",
          "query.truncated": "Results were cut at the row limit",
          "query.valid": "Flux parses cleanly",
          "query.invalid": "Flux check failed: ",
          "query.failed": "Query failed: ",
          "query.analyzing": "Checking…",
          "query.showing": "showing the first {n} rows",
          "write.disabled": "Writing is off (enable it on the Connections tab)",
          "tpl.raw": "Basic range/filter",
          "tpl.window": "Windowed aggregate",
          "tpl.latest": "Latest value",
          "tpl.rate": "Rate of change",
          "tpl.pivot": "Pivot fields",
          "tpl.groupcount": "Count per tag",
          "tpl.topn": "Top N",
          "tpl.join": "Join two fields",
          "tpl.threshold": "Threshold state",
          "tpl.downsample": "Downsample",
        };

        /**
         * Panel state that must survive unmounting.
         *
         * The `main` slot unmounts this component whenever the user switches to
         * another panel, which would otherwise discard the flux draft and the
         * result tables. This module-level record lives as long as the Client
         * module, so navigating away and back keeps the work.
         */
        const memory = {
          tab: "query",
          flux: "",
          templateId: "raw",
          activeId: "",
          result: null,
          error: "",
          note: "",
          health: {},
        };
        function t(key, params) {
          let text = key;
          if (typeof translate === "function") {
            try {
              const value = translate(key, params);
              if (typeof value === "string" && value !== "") text = value;
            } catch {
              /* fall through to the dictionary */
            }
          } else {
            const dictionary = currentDictionary();
            text = dictionary[key] ?? key;
          }
          if (params !== undefined && params !== null) {
            for (const name of Object.keys(params)) text = text.split("{" + name + "}").join(String(params[name]));
          }
          return text;
        }

        function currentDictionary() {
          let language = "";
          try {
            if (typeof document !== "undefined" && document.documentElement) language = document.documentElement.lang || "";
          } catch {
            language = "";
          }
          if (language === "") {
            try {
              language = typeof navigator !== "undefined" ? navigator.language || "" : "";
            } catch {
              language = "";
            }
          }
          return String(language).toLowerCase().indexOf("zh") === 0 ? ZH : EN;
        }

        /* ------------------------------------------------------------ rpc */

        async function rpc(op, payload) {
          const response = await fetch("/influxdb/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op, ...(payload ?? {}) }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (body === null) throw new Error("HTTP " + response.status);
          if (body.ok !== true) throw new Error(body.error || "HTTP " + response.status);
          return body.value;
        }

        /* --------------------------------------------------------- styles */

        const CSS = `
          .influx-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 13px; }
          .influx-head { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
          .influx-head-title { font-size: 15px; font-weight: 600; }
          .influx-head-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
          .influx-spacer { flex: 1; }
          .influx-tabs { display: flex; gap: 4px; padding: 8px 20px 0; }
          .influx-tab { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 12px; border-radius: 8px 8px 0 0; cursor: pointer; font: inherit; font-size: 13px; }
          .influx-tab[data-active="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); border-bottom-color: transparent; }
          .influx-body { flex: 1; min-height: 0; padding: 12px 20px 20px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
          .influx-body > * { flex: 0 0 auto; }
          .influx-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
          .influx-select, .influx-input { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 5px 8px; font-size: 12px; outline: none; }
          .influx-select:focus, .influx-input:focus { border-color: var(--dsw-alias-brand-primary); }
          .influx-btn { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer; }
          .influx-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
          .influx-btn:disabled { opacity: .5; cursor: default; }
          /* brand-primary is inverted between themes (near-black in light, near-white
             in dark), so the label must come from label-primary-inverted, never #fff. */
          .influx-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); font-weight: 550; }
          .influx-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
          .influx-btn-danger { color: var(--dsw-alias-state-error-primary); }
          .influx-editor { width: 100%; box-sizing: border-box; min-height: 190px; flex: 0 0 auto; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); outline: none; tab-size: 2; }
          .influx-editor:focus { border-color: var(--dsw-alias-brand-primary); }
          .influx-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); min-height: 20px; }
          .influx-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); }
          .influx-pill[data-state="ok"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
          .influx-pill[data-state="bad"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
          .influx-pill[data-state="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
          .influx-pill[data-state="idle"] { color: var(--dsw-alias-state-idle-primary); }
          .influx-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; white-space: pre-wrap; }
          .influx-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
          .influx-table-stack { display: flex; flex-direction: column; gap: 12px; }
          .influx-table-block { display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto; }
          .influx-table-caption { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 0 2px; }
          .influx-table-wrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); max-height: 42vh; min-height: 88px; }
          .influx-table { border-collapse: collapse; font-size: 12px; width: 100%; }
          .influx-table th { position: sticky; top: 0; background: var(--dsw-alias-bg-layer-2); text-align: left; padding: 6px 10px; font-weight: 600; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
          .influx-table td { padding: 4px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
          .influx-table tr:last-child td { border-bottom: none; }
          .influx-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
          .influx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
          .influx-field { display: flex; flex-direction: column; gap: 3px; }
          .influx-field > span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
          .influx-field .influx-input { width: 100%; box-sizing: border-box; }
          .influx-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
          .influx-empty { color: var(--dsw-alias-label-secondary); font-size: 12.5px; padding: 18px; text-align: center; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; }
          .influx-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
          .influx-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
          .influx-icon-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
        `;

        /* -------------------------------------------------------- icon */

        function InfluxIcon(props) {
          const size = props && typeof props.size === "number" ? props.size : 16;
          return h(
            "svg",
            {
              width: size,
              height: size,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.7,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": true,
            },
            h("path", { d: "M3 20h18" }),
            h("path", { d: "M5 20V11" }),
            h("path", { d: "M10 20V4" }),
            h("path", { d: "M15 20v-6" }),
            h("path", { d: "M20 20V8" }),
          );
        }

        /* -------------------------------------------------------- panel */

        function Panel() {
          // Seed from memory so returning to the panel restores the draft and
          // the last result instead of an empty editor.
          const [tab, setTabState] = React.useState(memory.tab);
          const [loaded, setLoaded] = React.useState(false);
          const [loadError, setLoadError] = React.useState("");
          const [allowWrite, setAllowWrite] = React.useState(false);
          const [connections, setConnections] = React.useState([]);
          const [templates, setTemplates] = React.useState([]);
          const [activeId, setActiveIdState] = React.useState(memory.activeId);
          const [health, setHealthState] = React.useState(memory.health);

          const [flux, setFluxState] = React.useState(memory.flux);
          const [running, setRunning] = React.useState(false);
          const [checking, setChecking] = React.useState(false);
          const [result, setResultState] = React.useState(memory.result);
          const [error, setErrorState] = React.useState(memory.error);
          const [note, setNoteState] = React.useState(memory.note);
          const [templateId, setTemplateIdState] = React.useState(memory.templateId);

          const [draft, setDraft] = React.useState([]);
          const [dirty, setDirty] = React.useState(false);
          const [saving, setSaving] = React.useState(false);
          const [saveMsg, setSaveMsg] = React.useState("");

          // Every mirrored setter keeps the module-level copy in step with React.
          const mirror = (key, setState) => (value) => {
            setState((previous) => {
              const next = typeof value === "function" ? value(previous) : value;
              memory[key] = next;
              return next;
            });
          };
          const setTab = mirror("tab", setTabState);
          const setActiveId = mirror("activeId", setActiveIdState);
          const setHealth = mirror("health", setHealthState);
          const setFlux = mirror("flux", setFluxState);
          const setResult = mirror("result", setResultState);
          const setError = mirror("error", setErrorState);
          const setNote = mirror("note", setNoteState);
          const setTemplateId = mirror("templateId", setTemplateIdState);

          const applyState = (value) => {
            setAllowWrite(value.allowWrite === true);
            setConnections(Array.isArray(value.connections) ? value.connections : []);
            setTemplates(Array.isArray(value.templates) ? value.templates : []);
            setDraft((previous) => (previous.length === 0 ? cloneConnections(value.connections) : previous));
            setActiveId((previous) => {
              if (previous !== "" && (value.connections ?? []).some((c) => c.id === previous)) return previous;
              const fallback = (value.connections ?? []).find((c) => c.default) ?? (value.connections ?? [])[0];
              return fallback ? fallback.id : "";
            });
          };

          const load = () => {
            rpc("state")
              .then((value) => {
                applyState(value);
                setLoaded(true);
                setLoadError("");
              })
              .catch((failure) => {
                setLoaded(true);
                setLoadError(String(failure && failure.message ? failure.message : failure));
              });
          };

          React.useEffect(load, []);

          const checkHealth = () => {
            setChecking(true);
            rpc("pingAll")
              .then((value) => {
                const next = {};
                for (const entry of value.results ?? []) next[entry.id] = entry;
                setHealth(next);
              })
              .catch(() => {})
              .finally(() => setChecking(false));
          };

          const run = () => {
            if (flux.trim() === "") {
              setError(t("query.empty"));
              return;
            }
            setRunning(true);
            setError("");
            setNote("");
            rpc("query", { query: flux, connection: activeId })
              .then((value) => {
                setResult(value);
                setNote(
                  `${value.rowCount} ${t("query.rows")} · ${value.tables.length} ${t("query.tables")} · ${value.durationMs} ${t("query.ms")}${
                    value.truncated ? " · " + t("query.truncated") : ""
                  }`,
                );
              })
              .catch((failure) => {
                setResult(null);
                setError(t("query.failed") + String(failure && failure.message ? failure.message : failure));
              })
              .finally(() => setRunning(false));
          };

          const validate = () => {
            if (flux.trim() === "") return;
            setChecking(true);
            setError("");
            setNote("");
            rpc("analyze", { query: flux, connection: activeId })
              .then((value) => {
                if (value.valid) {
                  setNote(t("query.valid") + (value.stages && value.stages.length ? " · " + value.stages.join(" → ") : ""));
                } else {
                  setError(t("query.invalid") + (value.error || ""));
                }
              })
              .catch((failure) => setError(t("query.invalid") + String(failure && failure.message ? failure.message : failure)))
              .finally(() => setChecking(false));
          };

          const insertTemplate = () => {
            if (activeId === "") return;
            const connection = connections.find((entry) => entry.id === activeId);
            rpc("template", {
              template: templateId,
              params: { bucket: connection && connection.bucket ? connection.bucket : "" },
            })
              .then((value) => setFlux(value.flux))
              .catch((failure) => setError(String(failure && failure.message ? failure.message : failure)));
          };

          const onKeyDown = (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              run();
            }
            if (event.key === "Tab") {
              event.preventDefault();
              const target = event.target;
              const start = target.selectionStart;
              const value = target.value;
              const next = value.slice(0, start) + "  " + value.slice(target.selectionEnd);
              setFlux(next);
              window.requestAnimationFrame(() => {
                target.selectionStart = start + 2;
                target.selectionEnd = start + 2;
              });
            }
          };

          /* connections editing */

          const updateDraft = (index, patch) => {
            setDraft((previous) => previous.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
            setDirty(true);
            setSaveMsg("");
          };

          const addConnection = () => {
            const next = {
              id: "influx-" + (draft.length + 1),
              label: "",
              url: "http://127.0.0.1:8086",
              org: "",
              bucket: "",
              token: "",
              tokenEnv: "INFLUX_TOKEN",
              default: draft.length === 0,
            };
            setDraft((previous) => [...previous, next]);
            setDirty(true);
            setSaveMsg("");
          };

          const removeConnection = (index) => {
            if (draft.length <= 1) {
              setSaveMsg(t("conn.keepOne"));
              return;
            }
            setDraft((previous) => {
              const next = previous.filter((_, position) => position !== index);
              if (!next.some((entry) => entry.default)) next[0].default = true;
              return next;
            });
            setDirty(true);
            setSaveMsg("");
          };

          const setDefault = (index) => {
            setDraft((previous) => previous.map((entry, position) => ({ ...entry, default: position === index })));
            setDirty(true);
            setSaveMsg("");
          };

          const save = () => {
            for (const entry of draft) {
              if (!/^https?:\/\//i.test(String(entry.url ?? ""))) {
                setSaveMsg(t("conn.invalidUrl"));
                return;
              }
            }
            setSaving(true);
            setSaveMsg("");
            rpc("saveConnections", { connections: draft, allowWrite })
              .then((value) => {
                setConnections(Array.isArray(value.connections) ? value.connections : []);
                setDraft(cloneConnections(value.connections));
                setDirty(false);
                setSaveMsg(t("conn.saved"));
              })
              .catch((failure) => setSaveMsg(t("conn.saveFailed") + String(failure && failure.message ? failure.message : failure)))
              .finally(() => setSaving(false));
          };

          /* render */

          const active = connections.find((entry) => entry.id === activeId);
          const activeHealth = health[activeId];

          const header = h(
            "div",
            { className: "influx-head" },
            h(InfluxIcon, { size: 18 }),
            h("div", null, h("div", { className: "influx-head-title" }, t("panel.title")), h("div", { className: "influx-head-sub" }, t("panel.subtitle"))),
            h("div", { className: "influx-spacer" }),
            allowWrite ? null : h("span", { className: "influx-pill", "data-state": "warn" }, t("write.disabled")),
            activeHealth
              ? h(
                  "span",
                  { className: "influx-pill", "data-state": activeHealth.ok ? "ok" : "bad", title: activeHealth.message || "" },
                  (activeHealth.ok ? t("conn.online") : t("conn.offline")) + (activeHealth.version ? " " + activeHealth.version : "") + ` ${activeHealth.durationMs}${t("query.ms")}`,
                )
              : h("span", { className: "influx-pill", "data-state": "idle" }, t("conn.unknown")),
            h(
              "button",
              { className: "influx-btn", onClick: checkHealth, disabled: checking || connections.length === 0, type: "button" },
              checking ? "…" : t("conn.checkAll"),
            ),
          );

          const tabs = h(
            "div",
            { className: "influx-tabs" },
            h("button", { className: "influx-tab", type: "button", "data-active": String(tab === "query"), onClick: () => setTab("query") }, t("tab.query")),
            h("button", { className: "influx-tab", type: "button", "data-active": String(tab === "connections"), onClick: () => setTab("connections") }, t("tab.connections")),
          );

          let body;
          if (!loaded) {
            body = h("div", { className: "influx-empty" }, "…");
          } else if (loadError !== "") {
            body = h("div", { className: "influx-error" }, t("query.failed") + loadError);
          } else if (tab === "query" && connections.length === 0) {
            // The Connections tab stays reachable so an empty profile can add one.
            body = h("div", { className: "influx-body" }, h("div", { className: "influx-empty" }, t("conn.none")));
          } else if (tab === "query") {
            body = h(
              "div",
              { className: "influx-body" },
              h(
                "div",
                { className: "influx-bar" },
                h("span", { className: "influx-hint" }, t("conn.select")),
                h(
                  "select",
                  {
                    className: "influx-select",
                    value: activeId,
                    onChange: (event) => setActiveId(event.target.value),
                  },
                  connections.map((entry) => h("option", { key: entry.id, value: entry.id }, `${entry.id}${entry.bucket ? " · " + entry.bucket : ""}`)),
                ),
                h("div", { className: "influx-spacer" }),
                h("span", { className: "influx-hint" }, t("query.template")),
                h(
                  "select",
                  { className: "influx-select", value: templateId, onChange: (event) => setTemplateId(event.target.value) },
                  templates.map((entry) => h("option", { key: entry.id, value: entry.id }, t("tpl." + entry.id))),
                ),
                h("button", { className: "influx-btn", type: "button", onClick: insertTemplate }, t("query.insertTemplate")),
              ),
              h("textarea", {
                className: "influx-editor",
                spellCheck: false,
                value: flux,
                placeholder: t("query.placeholder"),
                onChange: (event) => setFlux(event.target.value),
                onKeyDown,
              }),
              h(
                "div",
                { className: "influx-toolbar" },
                h("button", { className: "influx-btn influx-btn-primary", type: "button", onClick: run, disabled: running }, running ? t("query.running") : t("query.run")),
                h("button", { className: "influx-btn", type: "button", onClick: validate, disabled: checking }, checking ? t("query.analyzing") : t("query.validate")),
                h("button", { className: "influx-btn", type: "button", onClick: () => { setFlux(""); setResult(null); setError(""); setNote(""); } }, t("query.clear")),
                active ? h("span", { className: "influx-hint" }, `${active.url}${active.org ? " · org " + active.org : ""}`) : null,
              ),
              error !== "" ? h("div", { className: "influx-error" }, error) : null,
              note !== "" && error === "" ? h("div", { className: "influx-ok" }, note) : null,
              result !== null ? h(ResultTables, { result }) : h("div", { className: "influx-empty" }, t("query.empty")),
            );
          } else {
            body = h(
              "div",
              { className: "influx-body" },
              h(
                "div",
                { className: "influx-bar" },
                h("button", { className: "influx-btn", type: "button", onClick: addConnection }, t("conn.add")),
                h("div", { className: "influx-spacer" }),
                h("label", { className: "influx-hint", title: t("conn.allowWrite") },
                  h("input", {
                    type: "checkbox",
                    checked: allowWrite,
                    style: { verticalAlign: "middle", marginRight: 6 },
                    onChange: (event) => { setAllowWrite(event.target.checked); setDirty(true); setSaveMsg(""); },
                  }),
                  t("conn.allowWrite"),
                ),
                h("button", { className: "influx-btn influx-btn-primary", type: "button", onClick: save, disabled: !dirty || saving }, saving ? "…" : t("conn.save")),
              ),
              saveMsg !== "" ? h("div", { className: saveMsg === t("conn.saved") ? "influx-ok" : "influx-error" }, saveMsg) : null,
              draft.map((entry, index) =>
                h(
                  "div",
                  { className: "influx-card", key: entry.id + "-" + index },
                  h(
                    "div",
                    { className: "influx-bar" },
                    h("strong", null, entry.id || "—"),
                    entry.default ? h("span", { className: "influx-pill", "data-state": "ok" }, t("conn.default")) : null,
                    health[entry.id]
                      ? h("span", { className: "influx-pill", "data-state": health[entry.id].ok ? "ok" : "bad" }, health[entry.id].ok ? t("conn.online") : t("conn.offline"))
                      : null,
                    h("div", { className: "influx-spacer" }),
                    entry.default ? null : h("button", { className: "influx-btn", type: "button", onClick: () => setDefault(index) }, t("conn.setDefault")),
                    h("button", { className: "influx-btn influx-btn-danger", type: "button", onClick: () => removeConnection(index) }, t("conn.remove")),
                  ),
                  h(
                    "div",
                    { className: "influx-grid" },
                    field(t("conn.id"), h("input", { className: "influx-input", value: entry.id, onChange: (event) => updateDraft(index, { id: event.target.value }) })),
                    field(t("conn.label"), h("input", { className: "influx-input", value: entry.label ?? "", onChange: (event) => updateDraft(index, { label: event.target.value }) })),
                    field(t("conn.url"), h("input", { className: "influx-input", value: entry.url ?? "", onChange: (event) => updateDraft(index, { url: event.target.value }) })),
                    field(t("conn.org"), h("input", { className: "influx-input", value: entry.org ?? "", onChange: (event) => updateDraft(index, { org: event.target.value }) })),
                    field(t("conn.bucket"), h("input", { className: "influx-input", value: entry.bucket ?? "", onChange: (event) => updateDraft(index, { bucket: event.target.value }) })),
                    field(t("conn.tokenEnv"), h("input", { className: "influx-input", value: entry.tokenEnv ?? "", onChange: (event) => updateDraft(index, { tokenEnv: event.target.value }) })),
                    field(t("conn.token"), h("input", { className: "influx-input", type: "password", value: entry.token ?? "", placeholder: entry.tokenHint ?? "", onChange: (event) => updateDraft(index, { token: event.target.value }) })),
                  ),
                  h("div", { className: "influx-hint" }, t("conn.tokenHint")),
                ),
              ),
            );
          }

          return h(
            "div",
            { className: "influx-root" },
            h("style", null, CSS),
            header,
            tabs,
            body,
          );
        }

        function field(label, control) {
          return h("label", { className: "influx-field" }, h("span", null, label), control);
        }

        function ResultTables(props) {
          const result = props.result;
          const tables = Array.isArray(result.tables) ? result.tables : [];
          if (tables.length === 0) return h("div", { className: "influx-empty" }, "(no rows)");
          // Each table gets its own scroll area with a minimum height, and the
          // stack scrolls as a whole: many result parts must not squeeze each
          // other into unreadable slivers.
          return h(
            "div",
            { className: "influx-table-stack" },
            tables.map((table, index) =>
              h(
                "div",
                { className: "influx-table-block", key: "table-" + index },
                tables.length > 1
                  ? h("div", { className: "influx-table-caption" }, `table ${index + 1} · ${table.rows.length} row(s)`)
                  : null,
                h(
                  "div",
                  { className: "influx-table-wrap" },
                  h(
                    "table",
                    { className: "influx-table" },
                    h("thead", null, h("tr", null, table.columns.map((column) => h("th", { key: column }, column)))),
                    h(
                      "tbody",
                      null,
                      table.rows.map((row, rowIndex) =>
                        h(
                          "tr",
                          { key: "row-" + rowIndex },
                          row.map((cell, cellIndex) => h("td", { key: "cell-" + cellIndex }, cell === null || cell === undefined ? "" : String(cell))),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        }

        function cloneConnections(value) {
          return (Array.isArray(value) ? value : []).map((entry) => ({
            id: entry.id ?? "",
            label: entry.label ?? "",
            url: entry.url ?? "",
            org: entry.org ?? "",
            bucket: entry.bucket ?? "",
            // `undefined` means "unchanged": the Host keeps the stored secret.
            token: undefined,
            tokenEnv: entry.tokenEnv ?? "",
            default: entry.default === true,
            tokenHint: entry.tokenHint ?? "",
            tokenFrom: entry.tokenFrom ?? "none",
          }));
        }

        /* --------------------------------------------------------- apply */

        function apply(ctx) {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "dsh-influxdb: dictionaries");
          try {
            translate = ctx.locale.bind(NS);
          } catch {
            translate = null;
          }

          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register({ name: "sidebar.panellist", id: "dsh-influxdb", order: 21, locale: NS, label: () => t("panel.title") }, InfluxIcon),
          );

          ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "dsh-influxdb", locale: NS }, Panel));
        }

        return { name: "dsh-influxdb", inject: ["slots", "locale"], apply };
      },
    });
  } catch (error) {
    console.warn("[dsh-influxdb] client half failed to load:", error);
  }
})();
