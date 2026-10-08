import assert from "node:assert/strict";
import { mock } from "node:test";
import * as remote from "../src/remote-compaction.ts";

// Exercise the registered hook; replace only the two external model requests.
let localFailure;
let remoteFailure;
const local = { summary: "Portable summary", firstKeptEntryId: "kept", tokensBefore: 1000, details: { readFiles: [] } };
mock.module(new URL("../src/remote-compaction.ts", import.meta.url).href, {
  namedExports: {
    ...remote,
    generateBestEffortLocalSummary: async () => {
      if (localFailure) throw localFailure;
      return local;
    },
    callRemoteCompactionEndpoint: async () => {
      if (remoteFailure) throw remoteFailure;
      return { output: [{ type: "compaction", encrypted_content: "test-only" }] };
    },
  },
});
const { default: extension } = await import("../src/index.ts");
process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "1";
process.env.PI_OPENAI_SERVER_COMPACTION_NOTIFY = "0";

async function run({ hasUI = true, abort = false, localError, remoteError } = {}) {
  localFailure = localError;
  remoteFailure = remoteError;
  const handlers = new Map();
  const notices = [];
  const entries = [];
  const stderr = [];
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerProvider() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    getThinkingLevel: () => "low",
    appendEntry: (type, data) => entries.push({ type, data }),
  });
  const controller = new AbortController();
  if (abort) controller.abort();
  const log = mock.method(console, "error", (...args) => stderr.push(args.join(" ")));
  try {
    const result = await handlers.get("session_before_compact")({
      branchEntries: [],
      preparation: local,
      signal: controller.signal,
    }, {
      cwd: process.cwd(), hasUI,
      model: { provider: "openai-codex", api: "openai-codex-responses", id: "test", input: ["text"], reasoning: false },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-secret" }) },
      sessionManager: { getSessionId: () => "fallback-test" },
      getSystemPrompt: () => "test",
      ui: { notify: (message, level) => notices.push({ message, level }) },
    });
    return { result, notices, entries, stderr };
  } finally {
    log.mock.restore();
  }
}

const sensitive = "Bearer test-secret PRIVATE_PROVIDER_BODY";
const failure = new Error(`OpenAI remote compaction v2 failed (503): ${sensitive}`);
const fallback = await run({ remoteError: failure });
process.env.PI_OPENAI_SERVER_COMPACTION_NOTIFY = "1";
const enabledNotice = await run({ remoteError: failure });
process.env.PI_OPENAI_SERVER_COMPACTION_NOTIFY = "0";
assert.equal(enabledNotice.notices.length, 1, "notify=true must also warn");
assert.deepEqual(fallback.result, { compaction: local }, "keep the successful text summary intact");
assert.equal(fallback.notices.length, 1, "remote failure with a usable text summary must warn, even with notify=false");
assert.equal(fallback.notices[0].level, "warning");
assert.match(fallback.notices[0].message, /text summary/i);
assert.match(fallback.notices[0].message, /503/);
assert.equal(fallback.entries.length, 1, "record the fallback for later diagnosis");
assert.equal(fallback.entries[0].type, "openai-compaction-fallback");
assert.equal(fallback.entries[0].data.fallback, "text-summary");
assert.doesNotMatch(JSON.stringify(fallback), /test-secret|PRIVATE_PROVIDER_BODY/);
assert.deepEqual(fallback.stderr, [], "UI mode should not duplicate the warning on stderr");

const headless = await run({ remoteError: failure, hasUI: false });
assert.deepEqual(headless.notices, []);
assert.equal(headless.stderr.length, 1, "headless runs need a stderr diagnostic, not protocol stdout");
assert.equal(headless.entries.length, 1);
assert.doesNotMatch(JSON.stringify(headless), /test-secret|PRIVATE_PROVIDER_BODY/);

const bothFailed = await run({ remoteError: failure, localError: new Error("summary unavailable") });
assert.equal(bothFailed.result, undefined, "preserve Pi's default-compaction fallback");
assert.match(bothFailed.notices[0].message, /default compaction/i);
assert.equal(bothFailed.entries[0].data.fallback, "default-compaction");

for (const remoteError of [undefined, failure]) {
  const aborted = await run({ abort: true, remoteError });
  assert.deepEqual(aborted.result, { cancel: true });
  assert.deepEqual([aborted.notices, aborted.entries, aborted.stderr], [[], [], []], "user cancellation is not a remote failure");
}

for (const localError of [undefined, new Error("summary unavailable")]) {
  const success = await run({ localError });
  assert.equal(success.result.compaction.details.remoteCompaction.implementation, "responses_compaction_v2");
  assert.deepEqual([success.notices, success.entries, success.stderr], [[], [], []]);
}

for (const [remoteError, expected] of [
  [new Error("fetch failed", { cause: { code: "ECONNRESET" } }), /ECONNRESET/],
  [new Error("fetch failed", { cause: { code: sensitive } }), /Network request failed$/],
  [new Error("OpenAI remote compaction v2 stream ended before response.completed."), /stream ended/],
  [new Error("OpenAI remote compaction v2 expected exactly one compaction item, got 0."), /got 0/],
  [new DOMException("request timed out", "TimeoutError"), /timed out/],
  [new Error(sensitive), /details omitted/],
  [sensitive, /details omitted/],
]) {
  const result = await run({ remoteError });
  assert.equal(result.notices.length, 1);
  assert.equal(result.entries.length, 1);
  assert.match(result.entries[0].data.reason, expected);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|PRIVATE_PROVIDER_BODY/);
}
console.log("compaction fallback checks passed");
