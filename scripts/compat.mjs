import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getBranchMessages } from "../src/index.ts";
import { buildRemoteCompactionHeaders } from "../src/remote-compaction.ts";
import { applyPayloadPatch, applyRemoteHistoryPayloadPatch } from "../src/openai.ts";
import { buildResponseCreatePayload, buildWsRequestKey } from "../src/openai-ws-stream.ts";

const model = { provider: "openai", api: "openai-responses", id: "test", reasoning: true };
const tool = { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } };
const context = normalizeContext({
  systemPrompt: "Initial instructions.",
  tools: [],
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
});
const request = { model, context, tools: [], inputItems: [], options: undefined };
const oldKey = buildWsRequestKey(request);
context.messages.push({ role: "system", content: "Updated instructions.", toolsAdded: [tool] });
request.tools = getCurrentTools(context.messages);
const body = buildResponseCreatePayload(request);
assert.match(body.instructions, /Initial instructions/);
assert.match(body.instructions, /Updated instructions/);
assert.equal(body.tools[0].name, "lookup");
assert.notEqual(buildWsRequestKey(request), oldKey, "system/tool changes invalidate incremental WS continuity");

const headers = buildRemoteCompactionHeaders({
  model, apiKey: "fake-key", sessionId: "compat-test",
  headers: { "SESSION_ID": null, "X-Test": "present", "x-omitted": null },
});
assert.equal(headers.session_id, undefined, "null deletes headers case-insensitively");
assert.equal(headers["x-test"], "present");
assert.equal(headers["x-omitted"], undefined);
assert.equal(headers.authorization, "Bearer fake-key");

const system = { role: "developer", content: "Keep the current project rules." };
const addition = { type: "additional_tools", role: "developer", tools: [tool] };
const search = [
  { type: "tool_search_call", execution: "client", call_id: "load-1", arguments: {} },
  { type: "tool_search_output", execution: "client", call_id: "load-1", tools: [tool] },
];
const opaque = { type: "compaction", encrypted_content: "test-only" };
const payload = { input: [system, addition, ...search, { role: "user", content: "old summary" }], previous_response_id: "old" };
const patched = applyRemoteHistoryPayloadPatch({ payload, explicitHistory: [opaque] });
assert.deepEqual(patched.input, [system, addition, ...search, opaque], "remote replay must retain Pi 1.x system/tool transcript metadata");
assert.equal(patched.previous_response_id, undefined);
assert.equal(payload.previous_response_id, "old", "patch must not mutate source payload");
const cfg = { enabled: true, includeAzure: false, compactThreshold: 1000, thresholdRatio: 0.7, notify: false, usePreviousResponseId: false };
const stateless = applyPayloadPatch({ payload: { store: false, input: [] }, model, cfg, previousResponseId: "old" });
assert.equal(stateless.store, false, "disabling optional continuity must not enable server-side storage");
assert.equal(stateless.previous_response_id, undefined);
assert.equal(stateless.context_management[0].type, "compaction");
const session = SessionManager.inMemory(process.cwd());
session.appendMessage({ role: "user", content: "OLD_RAW_HISTORY_MUST_STAY_COMPACTED", timestamp: 0 });
const retained = session.appendMessage({ role: "user", content: "Recent request", timestamp: 1 });
session.appendCompaction("Previously verified summary", retained, 100000);
const projected = JSON.stringify(getBranchMessages(session.getBranch()));
assert.doesNotMatch(projected, /OLD_RAW_HISTORY_MUST_STAY_COMPACTED/, "installing after text compaction must not resurrect the entire raw log");
assert.match(projected, /Previously verified summary/);
assert.match(projected, /Recent request/);
// A clean home proves defaults without borrowing this machine\'s settings.
const cleanHome = mkdtempSync(join(tmpdir(), "pi-compaction-defaults-"));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_OPENAI_SERVER_COMPACTION_")));
  Object.assign(env, { HOME: cleanHome, USERPROFILE: cleanHome });
  const script = `import { loadConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)}; console.log(JSON.stringify(loadConfig(process.cwd())));`;
  const defaults = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: cleanHome, env, encoding: "utf8", windowsHide: true,
  }));
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.usePreviousResponseId, false, "fresh installs retain built-in transport/storage by default");
} finally {
  rmSync(cleanHome, { recursive: true, force: true });
}
console.log("Pi 1.x compatibility checks passed");
