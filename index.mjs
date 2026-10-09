// src/provider.mjs
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// src/transport.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// src/v2-transcript.mjs
var v2Rules = (rules) => rules.map((rule) => ({ action: rule.permission === "bash" ? "shell" : rule.permission, resource: rule.pattern, effect: rule.action }));
var v2Session = (session) => ({ ...session, directory: session.location.directory });
function v2Message(message, sessionID) {
  const role = message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : void 0;
  const info = {
    ...message,
    sessionID,
    role,
    providerID: message.model?.providerID,
    modelID: message.model?.id
  };
  if (!role) return { info, parts: [] };
  if (role === "user") return { info, parts: [{ id: `${message.id}:text:0`, sessionID, messageID: message.id, type: "text", text: message.text }] };
  const ordinals = { text: 0, reasoning: 0 };
  const parts = message.content.map((content) => {
    const base = { sessionID, messageID: message.id, type: content.type };
    if (content.type !== "tool") return { ...content, ...base, id: `${message.id}:${content.type}:${ordinals[content.type]++}` };
    return {
      ...base,
      id: `${message.id}:tool:${content.id}`,
      tool: content.name,
      state: {
        ...content.state,
        status: content.state.status === "streaming" ? "pending" : content.state.status,
        title: content.state.metadata?.title,
        output: content.state.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
        error: content.state.error?.message
      }
    };
  });
  return { info, parts };
}
function v2Catalog(providers, models) {
  return {
    connected: providers.map((provider) => provider.id),
    all: providers.map((provider) => ({
      ...provider,
      models: Object.fromEntries(models.filter((model) => model.providerID === provider.id && model.enabled).map((model) => {
        const cost = model.cost.find((tier) => !tier.tier);
        return [model.id, {
          ...model,
          cost: cost && { input: cost.input, output: cost.output, cache_read: cost.cache.read, cache_write: cost.cache.write }
        }];
      }))
    }))
  };
}
function v2Question(form) {
  const supported = form.metadata?.kind === "question" && form.fields.every((field) => (field.type === "string" || field.type === "multiselect") && !field.when?.length && !field.hidden);
  return {
    id: form.id,
    sessionID: form.sessionID,
    ...supported ? {} : { error: "This OpenCode form cannot be answered in GeckIt. Use a question with text or choices." },
    questions: supported ? form.fields.map((field) => ({
      question: field.description ?? field.title ?? form.title,
      options: (field.options ?? []).map((option) => ({ label: option.label, description: option.description })),
      custom: field.custom !== false
    })) : []
  };
}

// src/v2-events.mjs
function v2Events(hear, requests, forms, failures, ownedSession) {
  const messages = /* @__PURE__ */ new Map();
  const parts = /* @__PURE__ */ new Map();
  const emit = (type, properties) => hear({ type, properties });
  const updatePart = (part) => {
    parts.set(part.id, part);
    emit("message.part.updated", { part });
  };
  return (event) => {
    const p = event.data;
    if (!p) return;
    const sessionID = p.sessionID ?? p.form?.sessionID;
    if (ownedSession && sessionID !== ownedSession) return;
    if (event.type === "session.execution.started") failures.delete(sessionID);
    if (event.type === "session.execution.failed") failures.set(sessionID, p.error);
    if (event.type === "permission.asked") {
      requests.set(p.id, p.sessionID);
      emit("permission.asked", { ...p, permission: p.action, patterns: p.resources });
    }
    if (event.type === "permission.replied") {
      requests.delete(p.requestID);
      emit(event.type, p);
    }
    if (event.type === "form.created") {
      forms.set(p.form.id, p.form);
      emit("question.asked", v2Question(p.form));
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      forms.delete(p.id);
      emit(event.type === "form.replied" ? "question.replied" : "question.rejected", { ...p, requestID: p.id });
    }
    const messageID = p.assistantMessageID;
    if (event.type === "session.step.started") {
      const info = { id: messageID, sessionID, role: "assistant", providerID: p.model.providerID, modelID: p.model.id, time: { created: p.started } };
      messages.set(messageID, info);
      emit("message.updated", { info });
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const info = { ...messages.get(messageID), id: messageID, sessionID, role: "assistant", cost: p.cost, tokens: p.tokens, error: p.error };
      messages.set(messageID, info);
      emit("message.updated", { info });
    }
    const fragment = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(event.type);
    if (fragment) {
      const [, type, phase] = fragment;
      const id = `${messageID}:${type}:${p.ordinal}`;
      const previous = parts.get(id);
      updatePart({ id, sessionID, messageID, type, text: phase === "delta" ? (previous?.text ?? "") + p.delta : p.text ?? "" });
    }
    if (event.type.startsWith("session.tool.")) {
      const id = `${messageID}:tool:${p.id}`;
      const previous = parts.get(id);
      const base = { id, sessionID, messageID, type: "tool", tool: p.name ?? previous?.tool };
      const state = previous?.state ?? { status: "pending", input: "" };
      if (event.type === "session.tool.input.started") updatePart({ ...base, state });
      if (event.type === "session.tool.input.delta") updatePart({ ...base, state: { ...state, input: state.input + p.delta } });
      if (event.type === "session.tool.input.ended") updatePart({ ...base, state: { ...state, input: p.text } });
      if (event.type === "session.tool.called") updatePart({ ...base, state: { status: "running", input: p.input } });
      if (event.type === "session.tool.progress") updatePart({ ...base, state: { ...state, title: p.metadata.title } });
      if (event.type === "session.tool.success" || event.type === "session.tool.failed") updatePart({
        ...base,
        state: {
          ...state,
          status: p.error ? "error" : "completed",
          error: p.error?.message,
          output: p.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        }
      });
    }
    if (event.type === "session.retry.scheduled") emit("session.status", { sessionID, status: { type: "retry", message: p.error.message } });
    if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started") {
      for (const [id, info] of messages) if (info.sessionID === sessionID) messages.delete(id);
      for (const [id, part] of parts) if (part.sessionID === sessionID) parts.delete(id);
      for (const [id, owner] of requests) if (owner === sessionID) requests.delete(id);
      for (const [id, form] of forms) if (form.sessionID === sessionID) forms.delete(id);
    }
  };
}

// src/v2.mjs
import { setTimeout as delay } from "node:timers/promises";
var OpenCodeV2 = class {
  constructor(transport) {
    this.transport = transport;
    this.requests = /* @__PURE__ */ new Map();
    this.forms = /* @__PURE__ */ new Map();
    this.failures = /* @__PURE__ */ new Map();
  }
  async page(root, path, signal) {
    const data = [];
    let cursor;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const page = await this.transport.rawRequest(root, `${path}${separator}${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=asc"}`, "GET", void 0, signal);
      data.push(...page.data);
      cursor = page.cursor.next;
    } while (cursor);
    return data;
  }
  async request(root, path, method, body, signal, timeoutMs) {
    const raw = (path2, method2 = "GET", body2, deadline = 3e4) => this.transport.rawRequest(root, path2, method2, body2, signal, deadline);
    if (path === "/global/health") return raw("/api/info");
    if (path === "/provider") {
      const config = await raw("/api/config");
      const configured = /* @__PURE__ */ new Map();
      for (const entry of config.filter((entry2) => entry2.type === "document")) {
        for (const [id, provider] of Object.entries(entry.info.providers ?? {})) {
          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            configured.set(`${id}/${modelID}`, id === "ollama" && !provider.disabled && !model.disabled);
          }
        }
      }
      const expected = [...configured].filter(([, enabled]) => enabled).map(([id]) => id);
      const deadline = Date.now() + this.transport.startupMs;
      for (; ; ) {
        const [providers, models] = await Promise.all([raw("/api/provider"), raw("/api/model")]);
        const present = new Set(models.data.filter((model) => model.enabled).map((model) => `${model.providerID}/${model.id}`));
        const catalog2 = v2Catalog(providers.data, models.data);
        const ready = expected.every((id) => present.has(id));
        if (ready && catalog2.all.some((provider) => provider.id === "ollama" && Object.keys(provider.models).length)) return catalog2;
        if (Date.now() >= deadline) {
          if (!ready) throw new Error("OpenCode did not load the configured Ollama models.");
          return catalog2;
        }
        await delay(100, void 0, { signal });
      }
    }
    if (path === "/config") {
      const { data: model } = await raw("/api/model/default");
      return { model: model ? `${model.providerID}/${model.id}` : void 0 };
    }
    if (path === "/session") {
      if (method === "GET") return (await this.page(root, "/api/session", signal)).map(v2Session);
      const { permission: permission2, ...other } = body;
      const result = await raw("/api/session", method, { ...other, location: { directory: root }, permissions: v2Rules(permission2 ?? []) });
      return v2Session(result.data);
    }
    const session = /^\/session\/(ses_[A-Za-z0-9]+)(?:\/(message|abort|fork))?$/.exec(path);
    if (session) {
      const [, id, action] = session;
      const base = `/api/session/${id}`;
      if (!action) {
        if (method === "GET") return v2Session((await raw(base)).data);
        if (method === "DELETE") {
          await raw(base, method);
          return true;
        }
        const { permission: permission2, ...other } = body;
        await raw(base, method, { ...other, ...permission2 ? { permissions: v2Rules(permission2) } : {} });
        return;
      }
      if (action === "abort") return raw(`${base}/interrupt`, "POST");
      if (action === "fork") return v2Session((await raw(`${base}/fork`, method, body.messageID ? { before: body.messageID } : {})).data);
      if (method === "GET") return (await this.page(void 0, `${base}/message`, signal)).map((message) => v2Message(message, id));
      await raw(`${base}/model`, "POST", { model: { providerID: body.model.providerID, id: body.model.modelID } });
      await raw(`${base}/agent`, "POST", { agent: body.agent ?? "build" });
      const instruction = `/api/experimental/session/${id}/instructions/entries/geckit`;
      if (body.system) await raw(instruction, "PUT", { value: body.system });
      else await raw(instruction, "DELETE");
      await raw(`${base}/prompt`, "POST", { text: body.parts.map((part) => part.text).join("\n"), delivery: "steer" });
      await raw(`/api/experimental/session/${id}/wait`, "POST", void 0, timeoutMs ?? 0);
      const messages = await this.page(void 0, `${base}/message`, signal);
      const assistant = messages.findLast((message) => message.type === "assistant");
      const result = assistant ? v2Message(assistant, id) : { info: {}, parts: [] };
      const idle = messages.findLast((message) => message.type === "idle");
      if (idle?.outcome === "failed") result.info.error ??= this.failures.get(id) ?? { message: "OpenCode execution failed." };
      if (idle?.outcome === "interrupted") result.info.error ??= { message: "OpenCode execution was interrupted." };
      this.failures.delete(id);
      return result;
    }
    const permission = /^\/permission\/([^/]+)\/reply$/.exec(path);
    if (permission) {
      const id = decodeURIComponent(permission[1]);
      const owner = this.requests.get(id);
      if (!owner) throw new Error("OpenCode permission request is no longer pending.");
      await raw(`/api/session/${owner}/permission/${encodeURIComponent(id)}/reply`, "POST", { decision: body.reply });
      this.requests.delete(id);
      return true;
    }
    const question = /^\/question\/([^/]+)\/reply$/.exec(path);
    if (question) {
      const id = decodeURIComponent(question[1]);
      const form = this.forms.get(id);
      if (!form) throw new Error("OpenCode question is no longer pending.");
      const answer = Object.fromEntries(form.fields.map((field, i) => {
        const values = body.answers[i].map((label) => field.options?.find((option) => option.label === label)?.value ?? label);
        return [field.key, field.type === "multiselect" ? values : values[0]];
      }));
      await raw(`/api/session/${form.sessionID}/form/${encodeURIComponent(id)}/reply`, "POST", { answer });
      this.forms.delete(id);
      return true;
    }
    if (path === "/mcp") {
      const { data } = await raw("/api/mcp");
      return Object.fromEntries(data.map((server) => [server.name, server.status]));
    }
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(path)) return raw(`/api/experimental${path}`, method);
    throw new Error(`OpenCode 2 operation is unsupported: ${method} ${path}`);
  }
  subscribe(root, hear, failed, signal, sessionID) {
    return this.transport.subscribeAt(void 0, "/api/event", v2Events(hear, this.requests, this.forms, this.failures, sessionID), failed, signal);
  }
};

// src/transport.mjs
var OpenCodeTransport = class {
  constructor({ executable = process.env.GECKIT_OPENCODE_BIN ?? "opencode", launch = spawn, fetcher = fetch, startupMs = 15e3 } = {}) {
    this.executable = executable;
    this.launch = launch;
    this.fetcher = fetcher;
    this.startupMs = startupMs;
    this.disposed = false;
    this.requests = /* @__PURE__ */ new Set();
    this.v2 = new OpenCodeV2(this);
    this.log = () => {
    };
    this.sequence = 0;
  }
  start() {
    if (this.disposed) return Promise.reject(new Error("OpenCode library has been disposed."));
    if (this.starting) return this.starting;
    this.log("info", "transport.starting");
    this.password = randomBytes(24).toString("hex");
    this.starting = new Promise((resolve2, reject) => {
      const child = this.launch(this.executable, ["serve", "--hostname=127.0.0.1", "--port=0"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, OPENCODE_SERVER_USERNAME: "geckit", OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_PASSWORD: this.password }
      });
      this.child = child;
      let output = "";
      let settled = false;
      let failureLogged = false;
      const fail = (error) => {
        if (!failureLogged) {
          failureLogged = true;
          this.log("warn", "transport.failed", { errorKind: error.name ?? "Error" });
        }
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (this.child === child) {
          this.child = void 0;
          this.starting = void 0;
        }
        for (const controller of this.requests) controller.abort(error);
        child.kill();
      };
      const timer = setTimeout(() => fail(new Error("OpenCode server did not start within 15 seconds.")), this.startupMs);
      child.once("error", (error) => fail(new Error(`Cannot start OpenCode: ${error.message}`)));
      child.once("close", () => fail(new Error("OpenCode server exited.")));
      child.stderr.on("data", () => {
      });
      child.stdout.on("data", (data) => {
        if (settled) return;
        output = (output + data.toString()).slice(-8192);
        const found = /(?:^|\n)(opencode )?server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (!found) return;
        this.protocol = found[1] ? 1 : 2;
        const url = new URL(found[2]);
        if (url.port === "0") return;
        settled = true;
        clearTimeout(timer);
        this.log("info", "transport.started", { protocol: this.protocol });
        resolve2(url.origin);
      });
    });
    const pending = this.starting;
    void pending.catch(() => {
      if (this.starting === pending) {
        this.starting = void 0;
        this.log("warn", "transport.start.failed");
      }
    });
    return this.starting;
  }
  async response(root, path, method, body, signal, timeoutMs = 3e4) {
    if (root?.startsWith("ssh://")) throw new Error("OpenCode + Ollama runs only on this computer.");
    const base = await this.start();
    if (signal?.aborted) throw signal.reason;
    const url = new URL(path, base);
    const requestId = ++this.sequence;
    const began = Date.now();
    const resource = url.pathname.split("/").filter(Boolean)[url.pathname.startsWith("/api/") ? 1 : 0] ?? "root";
    this.log("debug", "transport.request.started", { requestId, method, resource, protocol: this.protocol });
    if (root) url.searchParams.set(this.protocol === 2 && url.pathname !== "/api/session" ? "location[directory]" : "directory", root);
    const controller = new AbortController();
    this.requests.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("OpenCode request timed out.")), timeoutMs) : void 0;
    const release = () => {
      clearTimeout(timer);
      this.requests.delete(controller);
    };
    try {
      const response = await this.fetcher(url, {
        method,
        signal: combined,
        headers: { Authorization: `Basic ${Buffer.from(`${this.protocol === 2 ? "opencode" : "geckit"}:${this.password}`).toString("base64")}`, "Content-Type": "application/json" },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2e3);
        throw Object.assign(new Error(`OpenCode ${method} ${url.pathname}: ${response.status} ${detail}`), { status: response.status });
      }
      this.log("debug", "transport.request.completed", { requestId, status: response.status, durationMs: Date.now() - began });
      return { response, release, controller };
    } catch (error) {
      this.log("warn", "transport.request.failed", { requestId, errorKind: error.name ?? "Error", status: error.status ?? null, durationMs: Date.now() - began });
      release();
      throw error;
    }
  }
  async request(root, path, method = "GET", body, signal, timeoutMs) {
    await this.start();
    return this.protocol === 2 ? this.v2.request(root, path, method, body, signal, timeoutMs) : this.rawRequest(root, path, method, body, signal, timeoutMs);
  }
  async rawRequest(root, path, method = "GET", body, signal, timeoutMs) {
    const { response, release } = await this.response(root, path, method, body, signal, timeoutMs);
    try {
      return response.status === 204 ? void 0 : await response.json();
    } finally {
      release();
    }
  }
  async subscribe(root, hear, failed, signal, sessionID) {
    await this.start();
    return this.protocol === 2 ? this.v2.subscribe(root, hear, failed, signal, sessionID) : this.subscribeAt(root, "/event", hear, failed, signal);
  }
  async subscribeAt(root, path, hear, failed, signal) {
    const { response, release, controller } = await this.response(root, path, "GET", void 0, signal);
    if (!response.body) {
      release();
      throw new Error("OpenCode event stream is missing.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const pump = async () => {
      let buffer = "";
      try {
        for (; ; ) {
          const { value, done: done2 } = await reader.read();
          if (done2) throw new Error("OpenCode event stream disconnected.");
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (data) hear(JSON.parse(data));
          }
          if (buffer.length > 4e6) throw new Error("OpenCode event frame is too large.");
        }
      } catch (error) {
        if (!signal?.aborted && (!controller.signal.aborted || controller.signal.reason?.name !== "AbortError")) failed(error);
      } finally {
        release();
        reader.releaseLock();
      }
    };
    release();
    this.requests.add(controller);
    const done = pump().finally(() => this.requests.delete(controller));
    return { close: async () => {
      controller.abort();
      await reader.cancel().catch(() => {
      });
      await done;
    } };
  }
  dispose() {
    this.log("info", "transport.disposed");
    this.disposed = true;
    for (const controller of this.requests) controller.abort(new Error("OpenCode library disposed."));
    this.child?.kill();
  }
};

// src/transcript.mjs
var family = "plugin:opencode-llama";
var geckitId = (id) => `${family}:${id}`;
function nativeId(id) {
  if (typeof id !== "string" || !id.startsWith(`${family}:`) || !/^ses_[A-Za-z0-9]+$/.test(id.slice(family.length + 1))) throw new Error("Session does not belong to OpenCode + Ollama.");
  return id.slice(family.length + 1);
}
var errorText = (error) => error?.data?.message ?? error?.message ?? "OpenCode request failed.";
var permissions = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "allow" }
];
function catalog(data, defaultModel) {
  const connected = new Set(data.connected ?? []);
  return (data.all ?? []).filter((provider) => provider.id === "ollama" && connected.has(provider.id)).flatMap((provider) => Object.entries(provider.models ?? {}).map(([id, model]) => {
    const value = `${provider.id}/${id}`;
    const cost = model.cost;
    return {
      value,
      id: value,
      name: model.name ?? id,
      isDefault: value === defaultModel,
      supportsAutoMode: false,
      ...model.limit?.context > 0 ? { contextWindow: model.limit.context } : {},
      ...model.limit?.output > 0 ? { maxOutputTokens: model.limit.output } : {},
      ...cost ? { pricing: {
        currency: "USD",
        ...Number.isFinite(cost.input) ? { input: cost.input } : {},
        ...Number.isFinite(cost.output) ? { output: cost.output } : {},
        ...Number.isFinite(cost.cache_read) ? { cacheRead: cost.cache_read } : {},
        ...Number.isFinite(cost.cache_write) ? { cacheWrite: cost.cache_write } : {}
      } } : {}
    };
  }));
}
function partItem(part, info) {
  if (!info || part.ignored || part.synthetic) return void 0;
  const at = info.time?.created;
  if (part.type === "text") return { kind: info.role === "user" ? "mine" : "theirs", id: part.id, text: part.text ?? "", ...at === void 0 ? {} : { at } };
  if (info.role !== "assistant") return void 0;
  if (part.type === "reasoning") return { kind: "thought", id: part.id, text: part.text ?? "" };
  if (part.type !== "tool") return void 0;
  const state = part.state ?? {};
  return {
    kind: "did",
    id: part.id,
    what: state.title ?? part.tool,
    detail: state.output ?? state.error ?? JSON.stringify(state.input ?? {}),
    live: state.status === "pending" || state.status === "running"
  };
}
function spend(info, window) {
  const tokens = info.tokens;
  return {
    ...tokens ? { used: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) } : {},
    ...window === void 0 ? {} : { window },
    ...Number.isFinite(info.cost) ? { cost: info.cost, currency: "USD", costKind: "api-equivalent" } : {}
  };
}
function conversation(messages, window) {
  const items = messages.flatMap(({ info, parts }) => parts.map((part) => partItem(part, info)).filter(Boolean));
  const assistants = messages.map(({ info }) => info).filter((info) => info.role === "assistant");
  const last = assistants.at(-1);
  return {
    items,
    tasks: [],
    ...window === void 0 ? {} : { window },
    ...assistants.some((info) => Number.isFinite(info.cost)) ? { cost: assistants.reduce((sum, info) => sum + (info.cost ?? 0), 0), currency: "USD", costKind: "api-equivalent" } : {},
    ...last === void 0 ? {} : { used: spend(last).used }
  };
}
function linksIn(items) {
  const found = /* @__PURE__ */ new Map();
  for (const item of [...items].reverse()) {
    if (item.kind !== "mine" && item.kind !== "theirs") continue;
    for (const match of item.text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (!found.has(url)) found.set(url, { url });
    }
  }
  return [...found.values()];
}

// src/driver.mjs
function holdOpenCode(provider, options, hear, left) {
  const id = nativeId(options.id);
  const { transport } = provider;
  const root = options.root;
  const messages = /* @__PURE__ */ new Map();
  const parts = /* @__PURE__ */ new Map();
  const sealedMessages = /* @__PURE__ */ new Set();
  const sealedParts = /* @__PURE__ */ new Set();
  const requests = /* @__PURE__ */ new Map();
  const grants = provider.grants.get(id) ?? [];
  provider.grants.set(id, grants);
  let disposed = false;
  let active;
  let stream;
  let mode = options.mode === "plan" ? "plan" : "manual";
  let cost = 0;
  let measuredCost = false;
  let stopping = Promise.resolve();
  let appliedMode;
  let capacity;
  let ready;
  let ending;
  const emit = (items = [], signals = [], gone = []) => hear({ items, signals, gone });
  const finish = (turn, how, text) => {
    if (active !== turn) return;
    active = void 0;
    provider.log?.(how === "failed" ? "warn" : "info", "session.turn.ended", { session: options.id, outcome: how });
    for (const ask of [...requests.keys()]) resolveRequest(ask, how === "stopped" ? "Stopped" : "Turn ended");
    emit([], [{ kind: "ended", how, ...text === void 0 ? {} : { text } }]);
  };
  const fail = (error) => {
    if (!active) return;
    const turn = active;
    turn.controller.abort(error);
    stopping = Promise.resolve().then(async () => {
      await ready?.catch(() => {
      });
      if (turn.prompted) await transport.request(root, `/session/${id}/abort`, "POST").catch(() => {
      });
    });
    finish(turn, "failed", errorText(error));
  };
  const updateInfo = (info) => {
    const previous = messages.get(info.id);
    messages.set(info.id, info);
    if (info.role === "assistant" && active) {
      if (Number.isFinite(info.cost)) {
        measuredCost = true;
        cost += info.cost - (previous?.cost ?? 0);
      }
      emit([], [{ kind: "spend", ...spend(info, capacity), ...measuredCost ? { cost, currency: "USD", costKind: "api-equivalent" } : {} }]);
    }
    emit([...parts.values()].filter((part) => part.messageID === info.id).map((part) => partItem(part, info)).filter((item) => item && item.kind !== "mine"));
  };
  const updatePart = (part) => {
    parts.set(part.id, part);
    const item = partItem(part, messages.get(part.messageID));
    if (item && item.kind !== "mine") emit([item], item.kind === "did" && item.live ? [{ kind: "doing", what: item.what }] : []);
  };
  const card = (ask, wanted, shown) => {
    emit([{ kind: "card", id: `card:${ask}`, card: shown }], [{ kind: "asks", ask, wanted }]);
  };
  const resolveRequest = (requestID, answer) => {
    const request = requests.get(requestID);
    if (!request) return;
    const asks = request.kind === "question" ? request.questions.map((_, index) => index === 0 ? requestID : `${requestID}#${index}`) : [requestID];
    for (const ask of asks) {
      const shown = request.cards.get(ask);
      emit(shown ? [{ kind: "card", id: `card:${ask}`, card: { ...shown, answered: answer } }] : [], [{ kind: "resolved", ask }]);
    }
    requests.delete(requestID);
  };
  const event = ({ type, properties: p = {} }) => {
    const session = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (session !== id) return;
    if (type === "message.updated" && !sealedMessages.has(p.info.id)) updateInfo(p.info);
    if (type === "message.part.updated" && !sealedParts.has(p.part.id)) updatePart(p.part);
    if (type === "message.part.delta") {
      const part = parts.get(p.partID);
      if (part && !sealedParts.has(p.partID) && p.field === "text") updatePart({ ...part, text: (part.text ?? "") + p.delta });
    }
    if (type === "message.part.removed") {
      parts.delete(p.partID);
      emit([], [], [p.partID]);
    }
    if (type === "message.removed") {
      const gone = [...parts.values()].filter((part) => part.messageID === p.messageID).map((part) => part.id);
      for (const part of gone) parts.delete(part);
      messages.delete(p.messageID);
      emit([], [], gone);
    }
    if (type === "permission.asked" && active && !requests.has(p.id)) {
      if (grants.some((grant) => grant.permission === p.permission && p.patterns.every((pattern) => grant.patterns.includes(pattern)))) {
        void transport.request(root, `/permission/${encodeURIComponent(p.id)}/reply`, "POST", { reply: "once" }).catch(fail);
        return;
      }
      const detail = (p.patterns ?? []).join("\n");
      const shown = { kind: "permission", title: `Allow ${p.permission}?`, detail };
      requests.set(p.id, { kind: "permission", permission: p.permission, patterns: p.patterns, cards: /* @__PURE__ */ new Map([[p.id, shown]]) });
      card(p.id, { kind: "other", tool: p.permission, detail }, shown);
    }
    if (type === "question.asked" && active && !requests.has(p.id)) {
      if (p.error) {
        fail(new Error(p.error));
        return;
      }
      const cards = /* @__PURE__ */ new Map();
      requests.set(p.id, { kind: "question", questions: p.questions, answers: [], cards });
      p.questions.forEach((question, index) => {
        const ask = index === 0 ? p.id : `${p.id}#${index}`;
        const choices = question.options.map((option) => option.label);
        const shown = { kind: "question", title: question.question, choices };
        cards.set(ask, shown);
        card(ask, { kind: "question", question: question.question, choices }, shown);
      });
    }
    if (type === "permission.replied") resolveRequest(p.requestID, requests.get(p.requestID)?.answerLabel ?? (p.reply === "reject" ? "Declined" : "Allowed once"));
    if (type === "question.replied" || type === "question.rejected") resolveRequest(p.requestID, type === "question.rejected" ? "Declined" : "Answered");
    if (type === "session.status" && p.status?.type === "retry") emit([], [{ kind: "doing", what: p.status.message }]);
  };
  const prepare = async () => {
    await provider.session(root, options.id);
    const history = await transport.request(root, `/session/${id}/message`);
    for (const { info, parts: saved } of history) {
      messages.set(info.id, info);
      sealedMessages.add(info.id);
      for (const part of saved) {
        parts.set(part.id, part);
        sealedParts.add(part.id);
      }
    }
    stream = await transport.subscribe(root, event, (error) => {
      ready = void 0;
      stream = void 0;
      fail(error);
    }, void 0, id);
    if (disposed) await stream.close();
  };
  const run = async (turn, text, images, before) => {
    try {
      await stopping;
      if (active !== turn || disposed) return;
      if (images?.length) throw new Error("OpenCode + Ollama accepts text only.");
      ready ??= prepare().catch((error2) => {
        ready = void 0;
        throw error2;
      });
      await ready;
      if (active !== turn || disposed) return;
      const model = await provider.chooseModel(root, options.model);
      if (active !== turn || disposed) return;
      capacity = model.contextWindow;
      const slash = model.value.indexOf("/");
      const rules = mode === "plan" ? [...permissions, ...["edit", "write", "apply_patch", "bash"].map((permission) => ({ permission, pattern: "*", action: "deny" }))] : permissions;
      if (appliedMode !== mode) {
        await transport.request(root, `/session/${id}`, "PATCH", { permission: rules }, turn.controller.signal);
        appliedMode = mode;
      }
      if (active !== turn || disposed) return;
      emit([], [{ kind: "started", session: geckitId(id), model: model.value, key: false, mode }]);
      turn.prompted = true;
      provider.log?.("info", "message.send.requested", { session: options.id });
      const result = await transport.request(root, `/session/${id}/message`, "POST", {
        model: { providerID: model.value.slice(0, slash), modelID: model.value.slice(slash + 1) },
        agent: mode === "plan" ? "plan" : "build",
        ...provider.instructions ? { system: provider.instructions } : {},
        parts: [{ type: "text", text: [...before ?? [], text].join("\n\n") }]
      }, turn.controller.signal, 0);
      provider.log?.("info", "message.send.completed", { session: options.id });
      if (active !== turn || disposed) return;
      const saved = await transport.request(root, `/session/${id}/message`, "GET", void 0, turn.controller.signal);
      if (active !== turn || disposed) return;
      const final = saved.findLast(({ info }) => info.role === "assistant" && !sealedMessages.has(info.id));
      const reply = final?.parts.some((part) => part.type === "text" && !part.ignored && !part.synthetic && part.text?.trim());
      for (const { info, parts: finalParts } of saved) {
        if (sealedMessages.has(info.id)) continue;
        updateInfo(info);
        sealedMessages.add(info.id);
        for (const part of finalParts) {
          updatePart(part);
          sealedParts.add(part.id);
        }
      }
      const error = result.info.error ? errorText(result.info.error) : reply ? void 0 : "OpenCode finished without a final text reply. Try another model or send again.";
      finish(turn, error ? "failed" : "done", error);
    } catch (error) {
      if (active === turn) fail(error);
    }
  };
  const stop = async () => {
    const turn = active;
    if (!turn) return;
    turn.controller.abort();
    stopping = Promise.resolve().then(async () => {
      await ready?.catch(() => {
      });
      if (disposed && !stream) return;
      await transport.request(root, `/session/${id}/abort`, "POST").catch(() => {
      });
    });
    finish(turn, "stopped");
    await stopping;
  };
  const driver = {
    send(text, images, before) {
      if (disposed) throw new Error("OpenCode driver has ended.");
      if (active) throw new Error("OpenCode is already answering this conversation.");
      const turn = { controller: new AbortController() };
      active = turn;
      provider.log?.("info", "session.turn.begun", { session: options.id });
      turn.done = run(turn, text, images, before);
    },
    answer(ask, answer) {
      const split = ask.lastIndexOf("#");
      const requestID = split < 0 ? ask : ask.slice(0, split);
      const request = requests.get(requestID);
      if (!request) return;
      const turn = active;
      void (async () => {
        if (request.kind === "permission") {
          const reply = answer === "once" || answer === "session" ? "once" : "reject";
          request.answerLabel = answer === "session" ? "Allowed for session" : reply === "reject" ? "Declined" : "Allowed once";
          await transport.request(root, `/permission/${encodeURIComponent(requestID)}/reply`, "POST", { reply });
          if (answer === "session") grants.push({ permission: request.permission, patterns: request.patterns });
          resolveRequest(requestID, request.answerLabel);
        } else {
          const index = split < 0 ? 0 : Number(ask.slice(split + 1));
          const question = request.questions[index];
          if (!question) return;
          if (question.custom === false && !question.options.some((option) => option.label === answer)) throw new Error("Choose one of the answers OpenCode offered.");
          request.answers[index] = [String(answer)];
          if (!request.questions.every((_, i) => request.answers[i] !== void 0)) return;
          await transport.request(root, `/question/${encodeURIComponent(requestID)}/reply`, "POST", { answers: request.answers });
          resolveRequest(requestID, "Answered");
        }
      })().catch((error) => {
        if (active === turn) fail(error);
      });
    },
    permit(_mode, again) {
      mode = "manual";
      emit([], [{ kind: "mode", mode }]);
      for (const ask of again) driver.answer(ask, "once");
    },
    stop() {
      void stop();
    },
    end() {
      ending ??= (async () => {
        disposed = true;
        await stop();
        await stopping;
        await ready?.catch(() => {
        });
        await stream?.close();
        provider.drivers.delete(driver);
        provider.log?.("info", "session.closed", { session: options.id });
        left();
      })();
      return ending;
    }
  };
  provider.drivers.add(driver);
  return driver;
}

// src/provider.mjs
var noModel = "No Ollama models available. Start Ollama and make a model available to OpenCode.";
var local = (root) => {
  if (root.startsWith("ssh://")) throw new Error("OpenCode + Ollama runs only on this computer.");
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
};
function create(context = {}, { transport = new OpenCodeTransport() } = {}) {
  const log = (level, event, fields) => {
    try {
      context.log?.write(level, event, fields);
    } catch {
    }
  };
  transport.log = log;
  log("info", "provider.created");
  const roots = /* @__PURE__ */ new Map();
  const windows = /* @__PURE__ */ new Map();
  const state = {
    transport,
    log,
    drivers: /* @__PURE__ */ new Set(),
    grants: /* @__PURE__ */ new Map(),
    instructions: void 0,
    async session(root, id) {
      const native = nativeId(id);
      const saved = await transport.request(root, `/session/${native}`);
      if (local(saved.directory) !== local(root)) throw new Error("OpenCode conversation belongs to another folder.");
      roots.set(id, local(root));
      return saved;
    },
    async chooseModel(root, value) {
      const models = await provider.models(root);
      const model = value ? models.find((model2) => model2.value === value) : models.find((model2) => model2.isDefault) ?? models[0];
      if (!model) throw new Error(value ? `Ollama model is not available: ${value}` : noModel);
      return model;
    }
  };
  const rootFor = async (id) => {
    nativeId(id);
    const root = roots.get(id);
    if (root) return root;
    const saved = await transport.request(void 0, `/session/${nativeId(id)}`);
    roots.set(id, local(saved.directory));
    return saved.directory;
  };
  const missing = (error) => error.status === 404;
  const provider = {
    id: family,
    family,
    name: "OpenCode + Ollama",
    shortName: "Ollama",
    icon: "opencode-llama",
    browser: "none",
    loginCommand: "opencode auth login",
    planName: "",
    localOnly: true,
    available: true,
    subscriptionOnly: false,
    images: false,
    remoteControl: false,
    nativeGoals: false,
    idleMs: 10 * 6e4,
    waitForExit: true,
    async account() {
      try {
        return { provider: family, here: true, signedIn: true, program: await provider.program() };
      } catch {
        return { provider: family, here: false, signedIn: void 0 };
      }
    },
    async program() {
      const health = await transport.request(void 0, "/global/health");
      return { version: health.version, path: transport.executable };
    },
    async models(root) {
      if (root?.startsWith("ssh://")) return [];
      const [data, config] = await Promise.all([transport.request(root, "/provider"), transport.request(root, "/config")]);
      const models = catalog(data, config.model);
      if (models.length && !models.some((model) => model.isDefault)) models[0].isDefault = true;
      for (const model of models) if (model.contextWindow !== void 0) windows.set(model.value, model.contextWindow);
      return models;
    },
    async limits(models) {
      log("debug", "limits.cache.returned", { models: models.length, knownWindows: models.filter((id) => windows.has(id)).length, backendCheck: false });
      return { windows: new Map(models.map((id) => [id, windows.get(id)])) };
    },
    async create({ root, model }) {
      local(root);
      await state.chooseModel(root, model);
      const session = await transport.request(root, "/session", "POST", { permission: permissions });
      const id = geckitId(session.id);
      nativeId(id);
      roots.set(id, local(root));
      return id;
    },
    async list(askedRoots) {
      const rows = [];
      const folders = /* @__PURE__ */ new Map();
      for (const root of askedRoots.filter((root2) => !root2.startsWith("ssh://"))) {
        const folder = local(root);
        if (!folders.has(folder)) folders.set(folder, root);
      }
      for (const [folder, root] of folders) {
        const saved = await transport.request(root, "/session");
        for (const session of saved) {
          if (local(session.directory) !== folder || session.time?.archived) continue;
          const id = geckitId(session.id);
          nativeId(id);
          roots.set(id, root);
          rows.push({ id, root, title: session.title ?? "OpenCode conversation", stands: "", at: session.time.updated, created: session.time.created, driven: false });
        }
      }
      return rows;
    },
    async search(askedRoots, asked) {
      if (!asked.trim()) return [];
      const found = [];
      const needle = asked.toLocaleLowerCase();
      for (const row of await provider.list(askedRoots)) {
        const saved = await provider.read(row.root, row.id);
        const matches = (saved?.items ?? []).filter((item) => (item.kind === "mine" || item.kind === "theirs") && item.text.toLocaleLowerCase().includes(needle));
        if (matches.length) {
          const text = matches.at(-1).text;
          const start = Math.max(0, text.toLocaleLowerCase().indexOf(needle) - 80);
          found.push({ id: row.id, root: row.root, count: matches.length, said: text.slice(start, start + 240) });
        }
      }
      return found;
    },
    hidden: async () => [],
    async has(root, id) {
      try {
        await state.session(root, id);
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
    async read(root, id) {
      try {
        await state.session(root, id);
        const messages = await transport.request(root, `/session/${nativeId(id)}/message`);
        const last = messages.findLast(({ info }) => info.role === "assistant")?.info;
        const model = last ? `${last.providerID}/${last.modelID}` : void 0;
        return conversation(messages, windows.get(model));
      } catch (error) {
        if (missing(error)) return void 0;
        throw error;
      }
    },
    links: async (root, id) => linksIn((await provider.read(root, id))?.items ?? []),
    async fork(root, id, at, _mode, model) {
      await state.session(root, id);
      await state.chooseModel(root, model);
      const messages = await transport.request(root, `/session/${nativeId(id)}/message`);
      const after = messages.find(({ info }) => info.time.created > at)?.info.id;
      const saved = await transport.request(root, `/session/${nativeId(id)}/fork`, "POST", after ? { messageID: after } : {});
      const fork = geckitId(saved.id);
      nativeId(fork);
      roots.set(fork, local(root));
      return { id: fork, begun: true, items: (await provider.read(root, fork))?.items ?? [] };
    },
    hold(options, hear, left) {
      local(options.root);
      return holdOpenCode(state, options, hear, left);
    },
    async rename(id, title) {
      await transport.request(await rootFor(id), `/session/${nativeId(id)}`, "PATCH", { title });
    },
    async delete(root, id) {
      try {
        await state.session(root, id);
        const result = await transport.request(root, `/session/${nativeId(id)}`, "DELETE");
        roots.delete(id);
        return result === true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
    goal: async () => void 0,
    setGoal: async () => void 0,
    clearGoal: async () => {
    },
    remote: async () => {
      throw new Error("OpenCode + Ollama does not support remote control.");
    },
    browsers: async () => void 0,
    async mcp(root, change) {
      if (change) await transport.request(root, `/mcp/${encodeURIComponent(change.name)}/${change.enabled ? "connect" : "disconnect"}`, "POST");
      const servers = await transport.request(root, "/mcp");
      return Object.entries(servers).map(([name, value]) => ({ name, status: value.status }));
    },
    async correct(text, instruction, model) {
      const root = homedir();
      let id;
      try {
        const selected = await state.chooseModel(root, model || void 0);
        const slash = selected.value.indexOf("/");
        const session = await transport.request(root, "/session", "POST", { title: "GeckIt correction", permission: [{ permission: "*", pattern: "*", action: "deny" }] });
        id = session.id;
        const result = await transport.request(root, `/session/${id}/message`, "POST", {
          model: { providerID: selected.value.slice(0, slash), modelID: selected.value.slice(slash + 1) },
          system: "Return only the requested text. Do not use tools.",
          tools: { "*": false },
          parts: [{ type: "text", text: `${instruction}

${text}` }]
        }, void 0, 9e4);
        if (result.info.error) return { ok: false, error: errorText(result.info.error) };
        const answer = result.parts.filter((part) => part.type === "text" && !part.ignored && !part.synthetic).map((part) => part.text).join("\n").trim();
        return answer ? { ok: true, text: answer } : { ok: false, error: "OpenCode returned no correction." };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      } finally {
        if (id) {
          await transport.request(root, `/session/${id}/abort`, "POST").catch(() => {
          });
          await transport.request(root, `/session/${id}`, "DELETE").catch(() => {
          });
        }
      }
    },
    async setInstructions(enabled) {
      const command = process.env.GECKIT_SOURCE_CLI ?? `${homedir()}/.geckit/bin/geckit`;
      state.instructions = enabled ? `This conversation is running in GeckIt. Use ${command} for board and conversation operations; run ${command} instructions app to read app guidance. Follow project AGENTS.md instructions. Never fabricate session links or claim unsupported native goals.` : void 0;
    },
    dispose() {
      log("info", "provider.disposed");
      for (const driver of state.drivers) void driver.end();
      transport.dispose();
    }
  };
  return provider;
}
export {
  create
};
