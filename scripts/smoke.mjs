import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, mkdtempSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");
const testHome = mkdtempSync(join(tmpdir(), "pi-compaction-smoke-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
process.env.CODEX_HOME = join(testHome, "codex");
// Never consult user configuration or reach a model service in smoke tests.
for (const [key, value] of Object.entries({
  ENABLED: "true", AZURE: "false", THRESHOLD: "80000", RATIO: "0.7",
  NOTIFY: "false", PREVIOUS_RESPONSE_ID: "true", REMOTE_PROVIDERS: "[]",
})) process.env[`PI_OPENAI_SERVER_COMPACTION_${key}`] = value;
globalThis.fetch = async () => { throw new Error("Unexpected network request in offline smoke"); };

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
const { streamOpenAIResponsesWithPhase2B } = await import(pathToFileURL(join(repoRoot, "src", "custom-stream.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  callRemoteCompactionEndpoint,
  messageToResponseItems,
  messagesToResponseItems,
  buildCodexWebSocketHeaders,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  extractRemoteCompactionDetails,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  createOpenAIWebSocketStreamFn,
  releaseAllWsSessions,
  selectInputItemsForContinuation,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);

const phasedAssistant = {
  role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-5.4-nano", stopReason: "stop",
  content: [
    { type: "text", text: "COMMENTARY", textSignature: JSON.stringify({ phase: "commentary" }) },
    { type: "text", text: "FINAL", textSignature: JSON.stringify({ phase: "final_answer" }) },
  ],
};
assert.deepEqual(messageToResponseItems(phasedAssistant).map(item => item.phase), ["commentary", "final_answer"]);
for (const stopReason of ["error", "aborted"]) {
  assert.deepEqual(messageToResponseItems({ ...phasedAssistant, stopReason }), [], "failed assistant fragments must not replay");
}
const foreignAssistant = { ...phasedAssistant, content: [
  { type: "thinking", thinking: "foreign", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_foreign", encrypted_content: "FOREIGN", summary: [] }) },
  { type: "text", text: "Visible foreign-model progress" },
] };
const foreignItems = messagesToResponseItems([foreignAssistant], { provider: "local", api: "openai-responses", id: "mock-sol" });
assert.ok(!foreignItems.some(item => item.type === "reasoning"));
assert.match(JSON.stringify(foreignItems), /Visible foreign-model progress/);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.equal(reconstructed, undefined, "cross-model dialogue must use Pi's portable context rather than silently discard progress");

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  "https://chatgpt.com/backend-api/codex/responses",
);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const websocketHeaders = buildCodexWebSocketHeaders("session-123");
assert.equal(websocketHeaders["x-client-request-id"], "session-123");
assert.equal(websocketHeaders.session_id, "session-123");
assert.equal(websocketHeaders["x-codex-window-id"], "session-123:0");

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const incrementalInput = selectInputItemsForContinuation({
  context: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user" }],
      },
    ],
  },
  model: { input: ["text"] },
  session: { lastContextLength: 2 },
  currentModelKey: targetModelKey,
  remoteCompactionState: undefined,
  previousResponseId: "resp_123",
});
assert.deepEqual(incrementalInput, [
  {
    type: "message",
    role: "user",
    content: "new user",
  },
]);

const { loadConfig } = await import(pathToFileURL(join(repoRoot, "src/config.ts")).href);
const { supportsRemoteCompactionModel, supportsPreviousResponseId, modelKey } =
  await import(pathToFileURL(join(repoRoot, "src/openai.ts")).href);
const state = await import(pathToFileURL(join(repoRoot, "src/state.ts")).href);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { normalizeContext } = await import("@earendil-works/pi-ai");
const { WebSocketServer } = await import("ws");

const localModel = {
  provider: "local", api: "openai-responses", id: "test:model", name: "offline",
  baseUrl: "http://local.invalid/gateway/api/", reasoning: true, input: ["text"],
  contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const officialModel = { ...localModel, provider: "openai", baseUrl: "https://api.openai.com/v1" };
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (model, text = "offline answer") => ({
  role: "assistant", provider: model.provider, api: model.api, model: model.id,
  content: [{ type: "text", text }], responseId: "resp_offline", stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: Date.now(),
});
const opaque = { type: "compaction", encrypted_content: "OFFLINE_OPAQUE" };
const tool = { name: "read", description: "read file", parameters: { type: "object", properties: {} } };

// Config precedence, exact provider matching, and explicit [] clearing.
const configHome = join(testHome, "config-home");
const configProject = join(testHome, "config-project");
mkdirSync(join(configHome, ".pi", "agent"), { recursive: true });
mkdirSync(join(configProject, ".pi"), { recursive: true });
writeFileSync(join(configHome, ".pi", "agent", "openai-server-compaction.json"),
  JSON.stringify({ remoteCompactionProviders: ["global"], thresholdRatio: 0.6 }));
const projectConfigPath = join(configProject, ".pi", "openai-server-compaction.json");
const readIsolatedConfig = (override) => {
  const env = { ...process.env, USERPROFILE: configHome, HOME: configHome };
  for (const key of Object.keys(env)) if (key.startsWith("PI_OPENAI_SERVER_COMPACTION_")) delete env[key];
  if (override !== undefined) env.PI_OPENAI_SERVER_COMPACTION_REMOTE_PROVIDERS = override;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src/config.ts")).href)}; console.log(JSON.stringify(loadConfig(process.cwd())));`,
  ], { cwd: configProject, env, encoding: "utf8" }));
};
assert.deepEqual(readIsolatedConfig().remoteCompactionProviders, ["global"]);
writeFileSync(projectConfigPath, JSON.stringify({ remoteCompactionProviders: ["local"], thresholdRatio: 0.8 }));
assert.deepEqual(readIsolatedConfig().remoteCompactionProviders, ["local"]);
assert.equal(readIsolatedConfig().thresholdRatio, 0.8);
assert.deepEqual(readIsolatedConfig('["env"]' ).remoteCompactionProviders, ["env"]);
assert.deepEqual(readIsolatedConfig("[]").remoteCompactionProviders, []);
writeFileSync(projectConfigPath, JSON.stringify({ remoteCompactionProviders: [] }));
assert.deepEqual(readIsolatedConfig().remoteCompactionProviders, []);

const defaults = loadConfig(testHome);
assert.deepEqual(defaults.remoteCompactionProviders, []);
assert.equal(supportsRemoteCompactionModel(localModel, defaults), false);
const optedIn = { ...defaults, remoteCompactionProviders: ["local"] };
assert.equal(supportsRemoteCompactionModel(localModel, optedIn), true);
for (const api of ["openai-completions", "azure-openai-responses", "openai-codex-responses", "anthropic-messages"]) {
  assert.equal(supportsRemoteCompactionModel({ ...localModel, api }, optedIn), false);
}
assert.equal(supportsRemoteCompactionModel({ ...localModel, provider: "LOCAL" }, optedIn), false);
assert.equal(supportsPreviousResponseId(localModel, optedIn), false);
assert.equal(supportsRemoteCompactionModel(officialModel, defaults), true);
assert.equal(supportsPreviousResponseId(officialModel, defaults), true);
assert.equal(supportsPreviousResponseId({ ...localModel, provider: "azure-openai" }, defaults), false);
assert.equal(supportsPreviousResponseId({ ...localModel, provider: "azure-openai" }, { ...defaults, includeAzure: true }), true);

for (const [baseUrl, expected] of [
  ["http://local.invalid/custom", "http://local.invalid/custom/responses"],
  ["http://local.invalid/v1/", "http://local.invalid/v1/responses"],
  ["http://local.invalid/custom/responses/", "http://local.invalid/custom/responses"],
]) assert.equal(remoteCompactionV2EndpointUrl({ ...localModel, baseUrl }), expected);
const localHeaders = buildRemoteCompactionHeaders({
  model: { ...localModel, headers: { "X-Model": "yes" } }, apiKey: "plain-key",
  headers: { Authorization: "Bearer override", "X-Extra": "yes" }, sessionId: "local-session",
});
assert.equal(localHeaders.authorization, "Bearer override");
assert.equal(localHeaders["x-model"], "yes");
assert.equal(localHeaders["x-extra"], "yes");
assert.doesNotMatch(JSON.stringify(localHeaders), /codex|chatgpt|session_id/);
assert.equal(buildRemoteCompactionHeaders({ model: localModel, apiKey: "unused", headers: { Authorization: null } }).authorization, undefined);
assert.equal(buildRemoteCompactionHeaders({ model: localModel, headers: { Authorization: "Basic offline" } }).authorization, "Basic offline");
const codexToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64url")}.sig`;
assert.equal(buildRemoteCompactionHeaders({ model: { ...localModel, provider: "openai-codex", api: "openai-codex-responses" }, apiKey: codexToken })["chatgpt-account-id"], "offline-account");
await assert.rejects(callRemoteCompactionEndpoint({ model: localModel, apiKey: "offline", input: [], tools: [], parallelToolCalls: true }), /only enabled/);

function harness(model = localModel, compacted = false) {
  const handlers = new Map();
  const providers = [];
  const session = SessionManager.inMemory(testHome);
  const oldUserId = session.appendMessage(user("OLD_INPUT"));
  session.appendMessage(assistant(model, "OLD_REPLY"));
  if (compacted) session.appendCompaction("portable summary", oldUserId, 100,
    { remoteCompaction: buildRemoteCompactionDetails(model, [opaque]) }, true);
  const pi = {
    registerProvider: (...args) => providers.push(args),
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => [tool], getActiveTools: () => ["read"], getThinkingLevel: () => "high",
  };
  const authCalls = [];
  const ctx = {
    cwd: testHome, model, sessionManager: session, hasUI: false,
    getSystemPrompt: () => "SYSTEM_PROMPT",
    modelRegistry: { getApiKeyAndHeaders: async (requestedModel) => {
      authCalls.push(requestedModel);
      return { ok: true, apiKey: "offline-key", headers: { "X-Auth": "resolved", Authorization: null },
        baseUrl: "http://local.invalid/auth-base" };
    } },
    ui: { notify: () => assert.fail("unexpected notification") },
  };
  extensionFactory(pi);
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const compact = (signal = new AbortController().signal) => emit("session_before_compact", {
    preparation: { firstKeptEntryId: oldUserId, tokensBefore: 100, settings: { reserveTokens: 100, keepRecentTokens: 20 },
      messagesToSummarize: [user("OLD_INPUT")], turnPrefixMessages: [], fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
    branchEntries: session.getBranch(), signal,
  });
  return { ctx, session, providers, authCalls, emit, compact };
}
const barePayload = { model: localModel.id, input: [{ role: "user", content: "ordinary input" }], store: false };
for (const model of [localModel, { ...localModel, api: "openai-completions" }]) {
  const h = harness(model, true);
  await h.emit("session_start");
  assert.deepEqual(h.providers.map(([name]) => name), ["openai"], "never register local");
  assert.equal(await h.compact(), undefined);
  assert.equal(await h.emit("before_provider_request", { payload: barePayload }), undefined);
  assert.equal(h.authCalls.length, 0);
}
process.env.PI_OPENAI_SERVER_COMPACTION_REMOTE_PROVIDERS = '["local"]';
const nonResponses = harness({ ...localModel, api: "openai-completions" }, true);
assert.equal(await nonResponses.compact(), undefined);
assert.equal(await nonResponses.emit("before_provider_request", { payload: barePayload }), undefined);
assert.equal(nonResponses.authCalls.length, 0);

// Real Pi HTTP adapter and extension compaction, with all HTTP replaced by deterministic SSE.
const requests = [];
const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url: String(url), headers: new Headers(init.headers), body });
  if (body.input?.at(-1)?.type === "compaction_trigger") {
    return sse([{ type: "response.output_item.done", item: opaque }, { type: "response.completed", response: { usage } }]);
  }
  const item = { type: "message", id: "msg_offline", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "PORTABLE_SUMMARY", annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_summary", model: localModel.id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PORTABLE_SUMMARY" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_summary", model: localModel.id, status: "completed", output: [item], usage } },
  ]);
};
const h = harness();
await h.emit("session_start");
const result = await h.compact();
assert.equal(result.compaction.summary, "PORTABLE_SUMMARY");
assert.deepEqual(result.compaction.details.remoteCompaction.replacementHistory.at(-1), opaque);
assert.equal(h.authCalls.length, 1);
assert.equal(requests.length, 2, "portable summary and remote compaction are both offline");
const remoteRequest = requests.find(({ body }) => body.input.at(-1).type === "compaction_trigger");
assert.equal(remoteRequest.url, "http://local.invalid/auth-base/responses");
assert.equal(remoteRequest.headers.get("authorization"), null);
assert.equal(remoteRequest.headers.get("x-auth"), "resolved");
assert.equal(remoteRequest.headers.get("chatgpt-account-id"), null);
assert.equal(remoteRequest.body.instructions, "SYSTEM_PROMPT");
assert.equal(remoteRequest.body.tools[0].name, "read");
assert.equal(remoteRequest.body.reasoning.effort, "high");
assert.equal(remoteRequest.body.previous_response_id, undefined);
assert.equal(remoteRequest.body.context_management, undefined);
assert.equal(remoteRequest.body.store, false);
assert.equal(requests.every(({ url }) => url.startsWith("http://local.invalid/auth-base/")), true);
h.session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, 100, result.compaction.details, true);
await h.emit("session_compact");
const pendingId = h.session.appendMessage(user("PENDING_AFTER_RESUME"));
await h.emit("session_start");
const promptItem = { role: "developer", content: "CURRENT_SYSTEM_PROMPT" };
const replayPayload = { ...barePayload, input: [promptItem, ...barePayload.input], previous_response_id: "must-remove", tools: [tool] };
const replay = await h.emit("before_provider_request", { payload: replayPayload });
assert.deepEqual(replay.input[0], promptItem);
assert.match(JSON.stringify(replay.input), /OFFLINE_OPAQUE.*PENDING_AFTER_RESUME/);
assert.equal(replay.previous_response_id, undefined);
assert.equal(replay.context_management, undefined);
assert.equal(replay.store, false);
assert.deepEqual(replay.tools, [tool]);
assert.equal(replayPayload.previous_response_id, "must-remove", "do not mutate caller payload");
assert.equal(state.getContinuationState(h.session.getSessionId()), undefined);
const answer = assistant(localModel, "NEW_REPLY");
h.session.appendMessage(answer);
await h.emit("message_end", { message: answer });
assert.match(JSON.stringify((await h.emit("before_provider_request", { payload: barePayload })).input), /NEW_REPLY/);
process.env.PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID = "false";
assert.match(JSON.stringify((await h.emit("before_provider_request", { payload: barePayload })).input), /OFFLINE_OPAQUE/);

process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "false";
const frozenState = structuredClone(state.getRemoteCompactionState(h.session.getSessionId()));
assert.equal(await h.emit("before_provider_request", { payload: replayPayload }), undefined);
assert.equal(await h.compact(), undefined);
await h.emit("message_end", { message: user("DISABLED") });
assert.deepEqual(state.getRemoteCompactionState(h.session.getSessionId()), frozenState);
assert.equal(h.authCalls.length, 1);
process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "true";
process.env.PI_OPENAI_SERVER_COMPACTION_REMOTE_PROVIDERS = "[]";
assert.equal(await h.emit("before_provider_request", { payload: replayPayload }), undefined, "removing allowlist stops replay");
process.env.PI_OPENAI_SERVER_COMPACTION_REMOTE_PROVIDERS = '["local"]';

// Ordinary local requests keep Pi's HTTP adapter, even if a caller asks for WebSocket.
const ordinaryContext = normalizeContext({ systemPrompt: "ORDINARY_SYSTEM", messages: [user("ORDINARY_USER")], tools: [tool] });
for (const enabled of ["true", "false"]) {
  process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = enabled;
  const before = requests.length;
  const ordinary = streamOpenAIResponsesWithPhase2B(localModel, ordinaryContext, {
    apiKey: "offline", sessionId: h.session.getSessionId(), transport: "websocket",
  });
  assert.equal((await ordinary.result()).stopReason, "stop");
  assert.equal(requests.length, before + 1);
  const sent = requests.at(-1);
  assert.equal(sent.url, "http://local.invalid/gateway/api/responses");
  assert.match(JSON.stringify(sent.body.input), /ORDINARY_SYSTEM/);
  assert.match(JSON.stringify(sent.body.input), /ORDINARY_USER/);
  assert.doesNotMatch(JSON.stringify(sent.body.input), /OFFLINE_OPAQUE/);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.previous_response_id, undefined);
  assert.equal(sent.body.context_management, undefined);
}
process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "true";
const successfulFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => JSON.parse(init.body).input.at(-1)?.type === "compaction_trigger"
  ? new Response("offline remote failure", { status: 400 }) : successfulFetch(url, init);
const failureHarness = harness();
const fallback = await failureHarness.compact();
assert.equal(fallback.compaction.summary, "PORTABLE_SUMMARY");
assert.equal(fallback.compaction.details?.remoteCompaction, undefined);
globalThis.fetch = successfulFetch;
let summaryAttempts = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.input.at(-1)?.type !== "compaction_trigger" && ++summaryAttempts === 1) {
    return new Response("offline portable summary failure", { status: 400 });
  }
  return successfulFetch(url, init);
};
const builtInFallback = await harness().compact();
assert.equal(builtInFallback.compaction.summary, "PORTABLE_SUMMARY");
assert.equal(summaryAttempts, 2, "failed portable summary falls back to Pi 1.5 compact");
assert.equal(requests.at(-1).headers.get("authorization"), null, "fallback preserves suppressed authentication header");
globalThis.fetch = successfulFetch;
assert.throws(() => parseRemoteCompactionV2Events([]), /before response.completed/);
assert.throws(() => parseRemoteCompactionV2Events([{ type: "response.completed", response: {} }]), /exactly one/);

// Terminal lifecycle cleanup, restoration after cancelled navigation, and model isolation.
for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"]) {
  await h.emit(event);
  assert.equal(state.getRemoteCompactionState(h.session.getSessionId()), undefined);
  assert.match(JSON.stringify((await h.emit("before_provider_request", { payload: barePayload })).input), /OFFLINE_OPAQUE/);
}
h.ctx.model = { ...localModel, id: "other" };
await h.emit("model_select");
assert.equal(await h.emit("before_provider_request", { payload: barePayload }), undefined);
h.ctx.model = localModel;
await h.emit("session_tree");
assert.ok(state.getRemoteCompactionState(h.session.getSessionId()));
h.session.appendContextEdit(pendingId, null);
assert.doesNotMatch(JSON.stringify((await h.emit("before_provider_request", { payload: barePayload })).input), /PENDING_AFTER_RESUME/);
const oldEntry = h.session.getBranch().find((entry) => entry.type === "message");
h.session.appendContextEdit(oldEntry.id, { content: "EDITED_PREFIX" });
assert.equal(await h.emit("before_provider_request", { payload: barePayload }), undefined,
  "edits to an opaque prefix must fall back to Pi's textual context");
await h.emit("session_shutdown");
assert.equal(state.getRemoteCompactionState(h.session.getSessionId()), undefined);
const aborted = new AbortController();
aborted.abort();
assert.deepEqual(await h.compact(aborted.signal), { cancel: true });

// Official OpenAI still has store/context management/continuation and explicit-history replay.
process.env.PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID = "true";
const official = harness(officialModel);
await official.emit("message_end", { message: assistant(officialModel) });
const officialPayload = await official.emit("before_provider_request", { payload: barePayload });
assert.equal(officialPayload.store, true);
assert.equal(officialPayload.context_management[0].type, "compaction");
assert.equal(officialPayload.previous_response_id, "resp_offline");
const officialReplay = harness(officialModel, true);
assert.match(JSON.stringify((await officialReplay.emit("before_provider_request", { payload: barePayload })).input), /OFFLINE_OPAQUE/);

// Real WebSocket transport on loopback: Pi 1.5 transcript prompt/tools reach the server.
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const wsRequests = [];
server.on("connection", (socket) => socket.on("message", (data) => {
  const request = JSON.parse(data.toString());
  wsRequests.push(request);
  socket.send(JSON.stringify({ type: "response.completed", response: {
    id: `resp_ws_${wsRequests.length}`, status: "completed", output: [], usage,
  } }));
}));
try {
  const streamFn = createOpenAIWebSocketStreamFn({ url: `ws://127.0.0.1:${server.address().port}/v1/responses`, maxRetries: 0 });
  const context = normalizeContext({ messages: [
    { role: "system", content: "BASE_PROMPT", toolsAdded: [tool], timestamp: 1 },
    user("WS_USER"),
    { role: "system", content: "PATCHED_PROMPT", timestamp: 2 },
  ] });
  const stream = streamFn(officialModel, context, { apiKey: "offline", sessionId: "ws-offline", openaiWsWarmup: true });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(events.map(({ type }) => type), ["start", "done"]);
  assert.equal(wsRequests.length, 2, "warmup and response");
  for (const request of wsRequests) {
    assert.match(request.instructions, /BASE_PROMPT/);
    assert.match(request.instructions, /PATCHED_PROMPT/);
    assert.equal(request.tools[0].name, "read");
  }
  assert.match(JSON.stringify(wsRequests[1].input), /WS_USER/);
} finally {
  releaseAllWsSessions();
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}
await official.emit("session_shutdown");
console.log("smoke ok: config, eligibility, auth/URL, offline HTTP compaction, replay, disable, lifecycle, OpenAI HTTP/WS");
