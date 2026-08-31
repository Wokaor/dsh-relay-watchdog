window.__ModuleLoader__.load({
  id: "dsh-relay-watchdog",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var NS = "relay-watchdog";

    // 字段声明：kind 决定渲染控件与解析方式。
    //   bool / text / textarea / number / int / csv / csvNumber
    var FIELDS = [
      { key: "enabled", kind: "bool", label: "总开关", hint: "关闭后不自动重试、不自动唤醒（但错误收集仍可开启）" },
      { key: "manualOverride", kind: "bool", label: "人工接管", hint: "开启后只检测/记录连接失败，不自动处理，方便手动介入" },
      { key: "collectAllErrors", kind: "bool", label: "收集所有 API 调用错误", hint: "日常对话里出现的模型调用错误都记入 incidents，避免以后漏判" },
      { key: "watchAll", kind: "bool", label: "监控所有对话", hint: "关闭后仅监控 sessionIdPattern 命中的会话" },
      { key: "sessionIdPattern", kind: "text", label: "会话 id 子串", hint: "watchAll=false 时生效；按会话 id 子串匹配" },
      { key: "retryableCodes", kind: "csv", label: "连接类错误码", hint: "逗号分隔或 JSON 数组，如 TRANSPORT, SERVER, RATE_LIMIT" },
      { key: "retryableStatuses", kind: "csvNumber", label: "连接类 HTTP 状态码", hint: "逗号分隔或 JSON 数组，如 500, 502, 503, 504, 524" },
      { key: "retryableMessagePatterns", kind: "csv", label: "按消息关键词匹配", hint: "逗号分隔；默认含 upstream / 524 / temporarily unavailable / rate limit exceeded，覆盖上游裸错误文本（如 pi-ai 的 PI_AI_ERROR、524 无响应体）" },
      { key: "maxRetries", kind: "int", label: "单步最大重试次数", hint: "超过后本步放弃，交由回合级复活" },
      { key: "stopAfterExhaustion", kind: "bool", label: "重试耗尽后终止本回合", hint: "默认开：耗尽后直接结束回合交由自动唤醒接管，避免与其它重试插件无限循环" },
      { key: "fastRetryCount", kind: "int", label: "快速重试次数", hint: "刚断联时先快速连试这么多次，再转入稳态间隔" },
      { key: "fastRetryDelayMs", kind: "number", label: "快速重试间隔（ms）", hint: "如 800 = 每 0.8s 快速试一次" },
      { key: "steadyRetryDelayMs", kind: "number", label: "稳态重试间隔（ms）", hint: "快速重试耗尽后，每隔这么长时间试一次" },
      { key: "rateLimitBaseDelayMs", kind: "number", label: "429 限流间隔（ms）", hint: "RATE_LIMIT 不做快速连试，直接按此固定间隔排队" },
      { key: "maxDelayMs", kind: "number", label: "Retry-After 上限（ms）", hint: "provider 返回 Retry-After 时的封顶值" },
      { key: "jitterRatio", kind: "number", label: "抖动比例", hint: "0~1，例如 0.1 = ±10% 随机抖动" },
      { key: "appendInstruction", kind: "bool", label: "重试前注入续跑指令" },
      { key: "instruction", kind: "textarea", label: "续跑指令模板", hint: "支持 {provider}/{code}/{status}/{message}/{turn}/{step}/{attempt}/{sessionId}/{model}" },
      { key: "instructionCooldownMs", kind: "number", label: "指令注入冷却（ms）", hint: "防止持续断连时消息刷屏" },
      { key: "restartOnTurnError", kind: "bool", label: "回合错误后自动重新唤醒" },
      { key: "reviveOnMaxTokens", kind: "bool", label: "输出截断后自动续跑", hint: "回合因达到 token 上限被截断时自动重新唤醒继续" },
      { key: "restartInstruction", kind: "textarea", label: "重新唤醒指令模板" },
      { key: "cutoffInstruction", kind: "textarea", label: "截断续跑指令模板", hint: "支持 {provider}/{model}/{code}/{status}/{message}/{count}/{sessionId}" },
      { key: "restartCooldownMs", kind: "number", label: "重新唤醒冷却（ms）" },
      { key: "maxAutoRestartsPerSession", kind: "int", label: "每会话最多自动唤醒次数" },
      { key: "resetBudgetOnSuccess", kind: "bool", label: "成功回合后重置复活预算", hint: "会话出现成功回合后自动唤醒次数归零重新计数" },
      { key: "enableApi", kind: "bool", label: "状态 API", hint: "GET /dsh-relay-watchdog/status（启动时注册）" },
      { key: "maxIncidents", kind: "int", label: "保留最近事件条数" },
    ];

    var byKey = {};
    FIELDS.forEach(function (f) { byKey[f.key] = f; });

    function hasOwn(obj, key) {
      return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function formatArray(arr) {
      return Array.isArray(arr) ? arr.join(", ") : "";
    }

    function parseField(kind, text) {
      var t = String(text == null ? "" : text).trim();
      if (t === "") return { kind: "clear" };
      if (kind === "number" || kind === "int") {
        var n = Number(t);
        if (!Number.isFinite(n)) return { kind: "invalid" };
        return { kind: "set", value: kind === "int" ? Math.trunc(n) : n };
      }
      if (kind === "csv" || kind === "csvNumber") {
        var arr;
        try {
          arr = JSON.parse(t);
        } catch (e) {
          arr = t.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        }
        if (!Array.isArray(arr)) return { kind: "invalid" };
        if (kind === "csvNumber") {
          var nums = arr.map(Number);
          if (nums.some(function (v) { return !Number.isFinite(v); })) return { kind: "invalid" };
          return { kind: "set", value: nums.map(Math.trunc) };
        }
        return { kind: "set", value: arr.map(String) };
      }
      // text / textarea
      return { kind: "set", value: t };
    }

    function Card(scope) {
      this.scope = scope;
      this.drafts = new Map();
      this.saving = false;
      this.failed = false;
      this.snapshot = null;
      this.listeners = new Set();
      var self = this;
      this.store = {
        getSnapshot: function () { return self.snapshot; },
        subscribe: function (fn) {
          self.listeners.add(fn);
          return function () { self.listeners.delete(fn); };
        },
      };
      this.unsub = scope.subscribe(function () { self.publish(); });
      this.publish();
    }

    Card.prototype.dispose = function () {
      if (this.unsub) { this.unsub(); this.unsub = null; }
    };

    Card.prototype.project = function () {
      var snap = this.scope.getSnapshot();
      var available = snap.status === "ready";
      var value = snap.value || {};
      var base = snap.base || {};
      var user = snap.user || {};
      var self = this;

      var fields = FIELDS.map(function (f) {
        var draft = self.drafts.get(f.key);
        var cur = value[f.key];
        var curBase = base[f.key];
        var overridden = hasOwn(user, f.key);
        var resetPending = !!(draft && draft.kind === "clear");
        var text = "";
        var checked = false;
        var invalid = false;

        if (f.kind === "bool") {
          if (draft && draft.kind === "bool") checked = draft.value;
          else checked = resetPending ? !!curBase : !!cur;
        } else {
          if (draft && draft.kind === "text") {
            text = draft.text;
            invalid = parseField(f.kind, draft.text).kind === "invalid";
          } else if (resetPending) {
            text = (f.kind === "csv" || f.kind === "csvNumber")
              ? formatArray(curBase)
              : (curBase == null ? "" : String(curBase));
          } else {
            text = (f.kind === "csv" || f.kind === "csvNumber")
              ? formatArray(cur)
              : (cur == null ? "" : String(cur));
          }
        }

        return {
          key: f.key,
          kind: f.kind,
          label: f.label,
          hint: f.hint,
          text: text,
          checked: checked,
          overridden: overridden,
          resetPending: resetPending,
          invalid: invalid,
        };
      });

      return {
        available: available,
        writable: !!snap.writable,
        saving: this.saving,
        failed: this.failed,
        dirty: this.drafts.size > 0,
        fields: fields,
      };
    };

    Card.prototype.publish = function () {
      this.snapshot = this.project();
      this.listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    };

    Card.prototype.edit = function (key, text) {
      this.drafts.set(key, { kind: "text", text: String(text == null ? "" : text) });
      this.failed = false;
      this.publish();
    };

    Card.prototype.toggle = function (key, checked) {
      this.drafts.set(key, { kind: "bool", value: !!checked });
      this.failed = false;
      this.publish();
    };

    Card.prototype.resetField = function (key) {
      this.drafts.set(key, { kind: "clear" });
      this.failed = false;
      this.publish();
    };

    Card.prototype.discard = function () {
      if (this.drafts.size === 0 && !this.failed) return;
      this.drafts.clear();
      this.failed = false;
      this.publish();
    };

    Card.prototype.save = async function () {
      if (this.saving) return;
      var self = this;
      var writes = [];
      var invalid = false;

      this.drafts.forEach(function (draft, key) {
        var f = byKey[key];
        if (!f) return;
        if (draft.kind === "clear") { writes.push({ key: key, op: "unset" }); return; }
        if (draft.kind === "bool") { writes.push({ key: key, op: "set", value: draft.value }); return; }
        var w = parseField(f.kind, draft.text);
        if (w.kind === "invalid") { invalid = true; return; }
        writes.push(w.kind === "clear" ? { key: key, op: "unset" } : { key: key, op: "set", value: w.value });
      });

      if (invalid) { this.failed = true; this.publish(); return; }
      if (writes.length === 0) { this.discard(); return; }

      this.saving = true;
      this.failed = false;
      this.publish();

      var landed = true;
      for (var i = 0; i < writes.length; i++) {
        var w = writes[i];
        try {
          if (w.op === "unset") await self.scope.unset(w.key);
          else await self.scope.set(w.key, w.value);
        } catch (e) {
          landed = false;
        }
      }

      if (landed) this.drafts.clear();
      this.saving = false;
      this.failed = !landed;
      this.publish();
    };

    var ROW_STYLE = {
      display: "grid",
      gridTemplateColumns: "minmax(180px, 320px) 1fr auto",
      gap: "8px",
      alignItems: "start",
      padding: "7px 0",
      borderBottom: "1px solid rgba(128,128,128,0.18)",
    };
    var LABEL_STYLE = { fontSize: "13px", lineHeight: "1.5", fontWeight: 600 };
    var HINT_STYLE = { fontSize: "11px", color: "rgba(128,128,128,0.95)", marginTop: "2px", lineHeight: 1.4 };
    var INPUT_STYLE = {
      width: "100%",
      boxSizing: "border-box",
      padding: "6px 8px",
      fontSize: "13px",
      fontFamily: "inherit",
      color: "inherit",
      background: "transparent",
      border: "1px solid rgba(128,128,128,0.45)",
      borderRadius: "6px",
    };
    var BTN_STYLE = {
      padding: "5px 10px",
      fontSize: "12px",
      borderRadius: "6px",
      border: "1px solid rgba(128,128,128,0.45)",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    };

    function Control(props, state, f) {
      if (f.kind === "bool") {
        return React.createElement("input", {
          type: "checkbox",
          checked: !!f.checked,
          disabled: !state.writable,
          onChange: function (e) { props.toggle(f.key, e.target.checked); },
          style: { width: 18, height: 18, cursor: "pointer" },
        });
      }
      if (f.kind === "textarea") {
        return React.createElement("textarea", {
          value: f.text,
          disabled: !state.writable,
          rows: 4,
          onChange: function (e) { props.edit(f.key, e.target.value); },
          style: Object.assign({}, INPUT_STYLE, { resize: "vertical", minHeight: 64 }),
        });
      }
      return React.createElement("input", {
        type: f.kind === "number" || f.kind === "int" ? "number" : "text",
        step: f.kind === "number" ? "any" : (f.kind === "int" ? "1" : undefined),
        value: f.text,
        disabled: !state.writable,
        onChange: function (e) { props.edit(f.key, e.target.value); },
        style: INPUT_STYLE,
      });
    }

    function fieldRow(props, state, f) {
      var children = [
        React.createElement("div", { key: "label", style: {} },
          React.createElement("div", { style: LABEL_STYLE },
            f.label,
            (f.overridden ? React.createElement("span", { style: { fontSize: "11px", color: "rgba(90,150,255,0.95)", marginLeft: 8 } }, "已覆盖") : null),
            (f.resetPending ? React.createElement("span", { style: { fontSize: "11px", color: "rgba(255,170,80,0.95)", marginLeft: 8 } }, "将重置") : null),
          ),
          f.hint ? React.createElement("div", { style: HINT_STYLE }, f.hint) : null,
        ),
        React.createElement("div", { key: "control", style: {} },
          Control(props, state, f),
          f.invalid ? React.createElement("div", { style: { fontSize: "11px", color: "rgba(255,90,90,0.95)", marginTop: 3 } }, "输入无法解析，保存会被拒绝") : null,
        ),
        React.createElement("div", { key: "reset", style: { display: "flex", alignItems: "center", minHeight: 28 } },
          (f.overridden || f.resetPending)
            ? React.createElement("button", { type: "button", style: BTN_STYLE, onClick: function () { props.resetField(f.key); } }, "重置")
            : null,
        ),
      ];
      return React.createElement("div", { key: f.key, style: ROW_STYLE }, children);
    }

    function RelayWatchdogCard(props) {
      var state = props.useRelayWatchdogCard(function (s) { return s; });
      if (!state || !state.available) {
        return React.createElement("p", { style: { fontSize: "13px", color: "rgba(128,128,128,0.95)" } },
          "relay-watchdog 设置暂不可用（服务未就绪）");
      }
      return React.createElement("div", { style: { fontFamily: "inherit", color: "inherit", maxWidth: 860 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 } },
          React.createElement("div", { style: { fontWeight: 700, fontSize: 14 } }, "中转站看门狗 · relay-watchdog"),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            state.dirty ? React.createElement("span", { style: { fontSize: 12, color: "rgba(255,170,80,0.95)" } }, "有未保存修改") : null,
            state.failed ? React.createElement("span", { style: { fontSize: 12, color: "rgba(255,90,90,0.95)" } }, "保存失败") : null,
            React.createElement("button", { type: "button", style: BTN_STYLE, disabled: !state.dirty || state.saving, onClick: function () { props.save(); } }, state.saving ? "保存中…" : "保存"),
            React.createElement("button", { type: "button", style: BTN_STYLE, disabled: !state.dirty || state.saving, onClick: function () { props.discard(); } }, "放弃修改"),
          ),
        ),
        state.fields.map(function (f) { return fieldRow(props, state, f); }),
        React.createElement("p", { style: { fontSize: 12, color: "rgba(128,128,128,0.9)", marginTop: 12, lineHeight: 1.6 } },
          "改动保存后立即生效，无需重启；错误收集记录可在 GET /dsh-relay-watchdog/status 的 incidents 里查看。")
      );
    }

    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: NS });
      var card = new Card(scope);
      ctx.effect(function () { return function () { card.dispose(); }; }, "dsh-relay-watchdog: settings card");

      // 独立成一个设置页（settings.section），而不是合并进「插件 → 可配置」的其它卡片里
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "relay-watchdog",
          order: 30,
          label: function () { return "中转站看门狗"; },
          inject: function () {
            return {
              hooks: { relayWatchdogCard: card.store },
              edit: function (key, text) { return card.edit(key, text); },
              toggle: function (key, checked) { return card.toggle(key, checked); },
              resetField: function (key) { return card.resetField(key); },
              save: function () { return card.save(); },
              discard: function () { return card.discard(); },
            };
          },
        }, RelayWatchdogCard);
      }, "dsh-relay-watchdog: settings section");
    }

    exports.inject = ["slots", "settingsScope"];
    exports.apply = apply;
    return module.exports;
  }
});