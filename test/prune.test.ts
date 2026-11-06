import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import pruneExtension from "../index.ts";
import { assertUnchanged, contextHash, createPrunedSession, planPrune, PRUNE_ENTRY } from "../prune.ts";

export const selection = { model: { provider: "example", id: "reasoner" }, thinkingLevel: "high", activeTools: ["read"] };
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-prune-test-"));
  const cwd = join(directory, "project");
  mkdirSync(cwd);
  const sm = SessionManager.create(cwd, join(directory, "sessions"));
  sm.appendModelChange("example", "reasoner");
  sm.appendThinkingLevelChange("high");
  sm.appendMessage({ role: "system", content: "", sections: { preamble: "Be precise.", old: "Remove this." },
    toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }], timestamp: 1 });
  sm.appendMessage({ role: "user", content: "ARCHIVE_ONLY_PAYLOAD ".repeat(4000), timestamp: 2 });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Old answer" }],
    provider: "example", model: "reasoner", api: "openai-responses", usage, stopReason: "stop", timestamp: 3 });
  const stateResult = sm.appendMessage({ role: "toolResult", toolCallId: "old-state-call", toolName: "example_state",
    content: [{ type: "text", text: "State committed" }], details: { items: ["preserved"] }, isError: false, timestamp: 4 });
  sm.appendMessage({ role: "toolResult", toolCallId: "old-image-call", toolName: "read", content: [
    { type: "image", data: "ARCHIVED_IMAGE".repeat(1000), mimeType: "image/png" },
  ], isError: false, timestamp: 5 });
  sm.appendCustomEntry("example.delta", { set: { a: 1 } });
  sm.appendCustomEntry("example.delta", { set: { b: 2 } });
  sm.appendCustomEntry("example.preference", { enabled: true });
  sm.appendCompaction("Earlier summary", stateResult, 50000, { readFiles: ["old.ts"], modifiedFiles: [] });
  sm.appendMessage({ role: "system", content: "", sections: { old: null, rules: "Keep exact signatures." }, timestamp: 6 });
  const user = sm.appendMessage({ role: "user", content: [
    { type: "text", text: "Current task" }, { type: "image", data: "KEPT_IMAGE", mimeType: "image/png" },
  ], timestamp: 7 });
  const call = sm.appendMessage({ role: "assistant", provider: "example", model: "reasoner", api: "openai-responses", usage,
    stopReason: "toolUse", content: [
      { type: "thinking", thinking: "Plan", thinkingSignature: "opaque-thinking" },
      { type: "toolCall", id: "kept-call", name: "read", arguments: { path: "file.ts" }, thoughtSignature: "opaque-call" },
    ], timestamp: 8 });
  const result = sm.appendMessage({ role: "toolResult", toolCallId: "kept-call", toolName: "read",
    content: [{ type: "text", text: "Original result" }], isError: false, timestamp: 9 });
  const compact = sm.appendCompaction("The existing summary, verbatim.", user, 80000,
    { readFiles: ["old.ts", "file.ts"], modifiedFiles: ["file.ts"] });
  sm.appendContextEdit(result, { content: [{ type: "text", text: "Edited result" }] });
  const omitted = sm.appendMessage({ role: "assistant", provider: "example", model: "reasoner", api: "openai-responses", usage,
    stopReason: "error", content: [{ type: "text", text: "Omitted failed attempt" }], timestamp: 10 });
  sm.appendContextEdit(omitted, null);
  sm.appendCustomMessageEntry("example.note", "Continue carefully.", true, { value: "visible" });
  sm.appendLabelChange(user, "current-task");
  sm.appendSessionInfo("Example project");
  return { sm, directory, cwd, user, call, result, compact, stateResult, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

// Tests contain synthetic records only. No provider or authentication is used.
test("keeps the exact projected context, signatures, state, edits, metadata and archive", () => {
  const f = fixture();
  try {
    const archive = readFileSync(f.sm.getSessionFile()!);
    const expected = f.sm.buildSessionProjection().messages;
    const plan = planPrune(f.sm);
    const path = createPrunedSession(plan, selection);
    const next = SessionManager.open(path);
    assert.notEqual(next.getSessionId(), f.sm.getSessionId());
    assert.equal(next.getHeader()?.parentSession, f.sm.getSessionFile());
    assert.equal(next.getCwd(), f.cwd);
    assert.equal(next.getSessionName(), "Example project");
    assert.equal(next.getLabel(f.user), "current-task");
    assert.deepEqual(next.buildSessionProjection().messages, expected);
    assert.equal(next.buildSessionContext().thinkingLevel, "high");
    assert.deepEqual(next.buildSessionContext().model, { provider: "example", modelId: "reasoner" });
    assert.deepEqual(next.getEntry(f.stateResult), plan.entries.find((entry) => entry.id === f.stateResult));
    assert.equal(next.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "example.delta").length, 2);
    assert.deepEqual(readFileSync(f.sm.getSessionFile()!), archive);
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes("ARCHIVE_ONLY_PAYLOAD"));
    assert.ok(!text.includes("ARCHIVED_IMAGE"));
    assert.ok(text.includes("KEPT_IMAGE"));
    assert.ok(statSync(path).size < archive.length / 4);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const ids = new Set(next.getEntries().map((entry) => entry.id));
    for (const entry of next.getEntries()) assert.ok(entry.parentId === null || ids.has(entry.parentId));
  } finally { f.cleanup(); }
});

test("preserves physical custom replay order without merging abandoned branches", () => {
  const f = fixture();
  try {
    const activeLeaf = f.sm.getLeafId()!;
    f.sm.branch(f.user);
    f.sm.appendCustomEntry("example.delta", { set: { abandoned: 99 } });
    f.sm.appendCustomEntry("example.preference", { enabled: false });
    f.sm.branch(activeLeaf);
    const state = (sm: SessionManager, branch: boolean) => (branch ? sm.getBranch() : sm.getEntries())
      .filter((entry) => entry.type === "custom" && entry.customType !== PRUNE_ENTRY)
      .map(({ parentId: _parent, ...entry }) => entry);
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    assert.deepEqual(state(next, false), state(f.sm, false));
    assert.deepEqual(state(next, true), state(f.sm, true));
    assert.equal(contextHash(next.buildSessionProjection().messages), contextHash(f.sm.buildSessionProjection().messages));
  } finally { f.cleanup(); }
});

test("retains state-bearing custom messages but not older plain injected text", () => {
  const f = fixture();
  try {
    const leaf = f.sm.getLeafId()!;
    f.sm.branch(f.stateResult);
    const state = f.sm.appendCustomMessageEntry("example.state-message", "Stored state", false, { cursor: 42 });
    const plain = f.sm.appendCustomMessageEntry("example.plain", "Not in current context", true);
    f.sm.branch(leaf);
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    assert.ok(next.getEntry(state));
    assert.equal(next.getEntry(plain), undefined);
  } finally { f.cleanup(); }
});

test("supports a retain-none compaction and continues to compact normally", () => {
  const f = fixture();
  try {
    f.sm.appendCompaction("No recent entries retained", null, 90000, { readFiles: ["file.ts"] });
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    assert.deepEqual(next.buildSessionProjection().messages, f.sm.buildSessionProjection().messages);
    assert.ok(next.getBranch().some((entry) => entry.type === "compaction" && entry.firstKeptEntryId === entry.id));
    const user = next.appendMessage({ role: "user", content: "Next task", timestamp: 20 });
    next.appendCompaction("Next summary", user, 90000);
    assert.ok(SessionManager.open(next.getSessionFile()!).buildSessionProjection().messages.some((m) => m.role === "user"));
  } finally { f.cleanup(); }
});

test("refuses un-compacted and ephemeral sessions", () => {
  assert.throws(() => planPrune(SessionManager.inMemory()), /saved session/);
  const f = fixture();
  try {
    const sm = SessionManager.create(f.cwd, f.sm.getSessionDir());
    sm.appendMessage({ role: "user", content: "No compaction", timestamp: 1 });
    assert.throws(() => planPrune(sm), /\/compact/);
  } finally { f.cleanup(); }
});

test("detects appended state, leaf movement and edited context while confirmation is open", () => {
  const f = fixture();
  try {
    const plan = planPrune(f.sm);
    assertUnchanged(f.sm, plan);
    f.sm.appendCustomEntry("example.state", { cursor: 2 });
    assert.throws(() => assertUnchanged(f.sm, plan), /Session changed/);
    const second = planPrune(f.sm);
    f.sm.branch(f.compact);
    assert.throws(() => assertUnchanged(f.sm, second), /Session changed/);
  } finally { f.cleanup(); }
});

test("verification failure removes only the new copy", () => {
  const f = fixture();
  try {
    const before = readdirSync(f.sm.getSessionDir());
    const original = readFileSync(f.sm.getSessionFile()!);
    const plan = planPrune(f.sm);
    plan.contextHash = "wrong";
    assert.throws(() => createPrunedSession(plan, selection), /verification failed/);
    assert.deepEqual(readdirSync(f.sm.getSessionDir()), before);
    assert.deepEqual(readFileSync(f.sm.getSessionFile()!), original);
  } finally { f.cleanup(); }
});

test("rejects invalid compaction references and invalid ancestry without touching the archive", () => {
  const f = fixture();
  try {
    const file = f.sm.getSessionFile()!;
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const latest = lines.find((entry) => entry.id === f.compact);
    latest.firstKeptEntryId = "missing";
    writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const original = readFileSync(file);
    assert.throws(() => planPrune(SessionManager.open(file)), /Invalid compaction/);
    assert.deepEqual(readFileSync(file), original);
    latest.firstKeptEntryId = f.user;
    lines.find((entry) => entry.id === f.stateResult).parentId = "missing";
    writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.throws(() => planPrune(SessionManager.open(file)), /Invalid session ancestry/);
  } finally { f.cleanup(); }
});

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
function commandHarness(sm: SessionManager) {
  let handler: CommandHandler | undefined;
  let start: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  let active = [...selection.activeTools];
  const notices: Array<{ text: string; type: string }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  let compaction: Parameters<ExtensionContext["compact"]>[0];
  let compactionCalls = 0;
  const settings = { confirm: true, idle: true, pending: false, hasUI: true, cancelSwitch: false, throwSwitch: false,
    duringConfirm: () => {}, startupChange: () => {} };
  const api = {
    registerCommand: (_name: string, options: { handler: CommandHandler }) => { handler = options.handler; },
    on: (_name: string, callback: typeof start) => { start = callback; },
    getThinkingLevel: () => selection.thinkingLevel,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  } as unknown as ExtensionAPI;
  pruneExtension(api);
  let stale = false;
  let switched: SessionManager | undefined;
  const ui = { confirm: async (title: string, message: string) => {
      confirmations.push({ title, message }); settings.duringConfirm(); return settings.confirm;
    },
    notify: (text: string, type: string) => { notices.push({ text, type }); } };
  const raw = {
    sessionManager: sm, hasUI: settings.hasUI, model: selection.model, thinkingLevel: selection.thinkingLevel,
    isIdle: () => settings.idle, hasPendingMessages: () => settings.pending, ui,
    compact: (options: Parameters<ExtensionContext["compact"]>[0]) => { compactionCalls++; compaction = options; },
    switchSession: async (path: string, options: Parameters<ExtensionCommandContext["switchSession"]>[1]) => {
      if (settings.throwSwitch) throw new Error("Simulated switch failure");
      if (settings.cancelSwitch) return { cancelled: true };
      stale = true;
      switched = SessionManager.open(path);
      const next = { sessionManager: switched, model: selection.model, thinkingLevel: selection.thinkingLevel, ui,
        getSystemPromptOptions: () => ({ selectedTools: active }) } as unknown as ExtensionCommandContext;
      // A new extension instance restores tools; the old pi object is never used after switching.
      const replacementApi = { ...api, on: (_name: string, callback: typeof start) => { start = callback; } };
      pruneExtension(replacementApi as ExtensionAPI);
      active = ["read", "write"];
      start?.({}, next);
      settings.startupChange();
      await options?.withSession?.({ ...next, sendMessage: async () => {}, sendUserMessage: async () => {} });
      return { cancelled: false };
    },
  };
  const ctx = new Proxy(raw, { get(target, property, receiver) {
    if (stale) throw new Error("Old context is stale");
    if (property === "hasUI") return settings.hasUI;
    return Reflect.get(target, property, receiver);
  } }) as unknown as ExtensionCommandContext;
  return { settings, notices, confirmations, compaction: () => compaction, compactionCalls: () => compactionCalls,
    run: (args = "") => handler!(args, ctx), switched: () => switched };
}

test("command switches only after confirmation and validation, and does not reuse stale contexts", async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.sm.getSessionFile()!);
    const h = commandHarness(f.sm);
    await h.run();
    assert.ok(h.switched());
    assert.equal(h.compactionCalls(), 0);
    assert.deepEqual(h.confirmations, [{ title: "Prune session?",
      message: "Continue with the same context in a smaller session?\nOriginal archive kept (/resume)." }]);
    assert.deepEqual(readFileSync(f.sm.getSessionFile()!), original);
    assert.deepEqual(h.switched()!.buildSessionProjection().messages, f.sm.buildSessionProjection().messages);
    assert.equal(h.notices.at(-1)?.type, "info");
    assert.match(h.notices.at(-1)!.text, /Original archive preserved/);
  } finally { f.cleanup(); }
});

test("command rejects busy, queued, headless and invalid-argument invocations without creating files", async () => {
  for (const scenario of ["busy", "pending", "headless", "arguments", "declined", "changed", "became-busy"] as const) {
    const f = fixture();
    try {
      const h = commandHarness(f.sm);
      const before = readdirSync(f.sm.getSessionDir());
      if (scenario === "busy") h.settings.idle = false;
      if (scenario === "pending") h.settings.pending = true;
      if (scenario === "headless") h.settings.hasUI = false;
      if (scenario === "declined") h.settings.confirm = false;
      if (scenario === "changed") h.settings.duringConfirm = () => { f.sm.appendCustomEntry("example.state", 1); };
      if (scenario === "became-busy") h.settings.duringConfirm = () => { h.settings.idle = false; };
      await h.run(scenario === "arguments" ? "--force" : "");
      assert.equal(h.switched(), undefined, scenario);
      assert.deepEqual(readdirSync(f.sm.getSessionDir()), before, scenario);
    } finally { f.cleanup(); }
  }
});

test("cancelled switch removes its prepared file; failed switch preserves it for recovery", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    try {
      const h = commandHarness(f.sm);
      h.settings.cancelSwitch = !fail;
      h.settings.throwSwitch = fail;
      const before = readdirSync(f.sm.getSessionDir());
      await h.run();
      assert.equal(h.switched(), undefined);
      assert.equal(readdirSync(f.sm.getSessionDir()).length, before.length + (fail ? 1 : 0));
      assert.match(h.notices.at(-1)!.text, fail ? /Simulated switch failure/ : /cancelled/);
    } finally { f.cleanup(); }
  }
});

test("tool-restore marker is ignored once further entries have been appended", () => {
  const f = fixture();
  try {
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    next.appendCustomEntry("example.next", {});
    let start: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
    let calls = 0;
    pruneExtension({ registerCommand() {}, on(_name: string, callback: typeof start) { start = callback; },
      setActiveTools() { calls++; } } as unknown as ExtensionAPI);
    start?.({}, { sessionManager: next } as unknown as ExtensionContext);
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test("warns rather than claiming equivalence when another startup hook changes context", async () => {
  const f = fixture();
  try {
    const h = commandHarness(f.sm);
    h.settings.startupChange = () => { h.switched()!.appendCustomMessageEntry("example.startup", "Added on startup", false); };
    await h.run();
    assert.ok(h.switched());
    assert.equal(h.notices.at(-1)?.type, "warning");
    assert.match(h.notices.at(-1)!.text, /startup extensions or settings changed/i);
  } finally { f.cleanup(); }
});

test("keeps older compactions inside the retained range without adding their summaries to context", () => {
  const f = fixture();
  try {
    f.sm.appendCompaction("Newest summary", f.user, 90000);
    const before = f.sm.buildSessionProjection().messages;
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    assert.deepEqual(next.buildSessionProjection().messages, before);
    assert.equal(next.buildSessionProjection().messages.filter((message) => message.role === "compactionSummary").length, 1);
    for (const entry of next.getEntries()) {
      if (entry.type === "compaction") assert.ok(next.getEntry(entry.firstKeptEntryId));
    }
  } finally { f.cleanup(); }
});

test("rejects a cyclic parent before asking Pi to walk the branch", () => {
  const f = fixture();
  try {
    const all = f.sm.getEntries();
    const broken = { ...all[0], parentId: all[0].id };
    const source = { getSessionFile: () => f.sm.getSessionFile(), getHeader: () => f.sm.getHeader(),
      getEntries: () => [broken, ...all.slice(1)], getBranch: () => { throw new Error("Must not walk corrupt history"); } };
    assert.throws(() => planPrune(source as unknown as ExtensionContext["sessionManager"]), /Invalid session ancestry/);
  } finally { f.cleanup(); }
});

test("does not create another session when all remaining records are required", () => {
  const f = fixture();
  try {
    const next = SessionManager.open(createPrunedSession(planPrune(f.sm), selection));
    const files = readdirSync(next.getSessionDir());
    assert.throws(() => planPrune(next), /Nothing to prune/);
    assert.deepEqual(readdirSync(next.getSessionDir()), files);
  } finally { f.cleanup(); }
});

function uncompactedFixture() {
  const f = fixture();
  // Other branches have compactions, but this active branch has never been compacted.
  f.sm.branch(f.stateResult);
  const kept = f.sm.appendMessage({ role: "user", content: "Current question", timestamp: 20 });
  return { ...f, kept };
}

function completeCompaction(sm: SessionManager, kept: string, h: ReturnType<typeof commandHarness>) {
  sm.appendCompaction("New summary", kept, 90000);
  h.compaction()!.onComplete!({ summary: "New summary", firstKeptEntryId: kept, tokensBefore: 90000, estimatedTokensAfter: 1000 });
}

test("uncompacted branch waits for successful compaction, then prunes with one informed confirmation", async () => {
  const f = uncompactedFixture();
  try {
    const h = commandHarness(f.sm);
    const archive = readFileSync(f.sm.getSessionFile()!);
    const files = readdirSync(f.sm.getSessionDir());
    const run = h.run();
    await Promise.resolve();
    assert.equal(h.compactionCalls(), 1);
    assert.equal(h.switched(), undefined);
    assert.deepEqual(readdirSync(f.sm.getSessionDir()), files);
    assert.deepEqual(readFileSync(f.sm.getSessionFile()!), archive);
    assert.deepEqual(h.confirmations, [{ title: "Compact and prune?",
      message: "Compact first (model call; may incur costs), then prune.\nOriginal archive kept (/resume)." }]);
    completeCompaction(f.sm, f.kept, h);
    const compactedArchive = readFileSync(f.sm.getSessionFile()!);
    const expected = f.sm.buildSessionProjection().messages;
    await run;
    assert.ok(h.switched());
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.compactionCalls(), 1);
    assert.deepEqual(h.switched()!.buildSessionProjection().messages, expected);
    assert.deepEqual(readFileSync(f.sm.getSessionFile()!), compactedArchive);
    assert.deepEqual(compactedArchive.subarray(0, archive.length), archive);
  } finally { f.cleanup(); }
});

test("compaction failure, cancellation and too-small sessions never create or switch a continuation", async () => {
  for (const error of ["Provider failed", "Compaction cancelled", "Nothing to compact (session too small)"]) {
    const f = uncompactedFixture();
    try {
      const h = commandHarness(f.sm);
      const files = readdirSync(f.sm.getSessionDir());
      const archive = readFileSync(f.sm.getSessionFile()!);
      const run = h.run();
      await Promise.resolve();
      assert.equal(h.compactionCalls(), 1);
      h.compaction()!.onError!(new Error(error));
      await run;
      assert.equal(h.switched(), undefined);
      assert.deepEqual(readdirSync(f.sm.getSessionDir()), files);
      assert.deepEqual(readFileSync(f.sm.getSessionFile()!), archive);
      assert.equal(h.notices.at(-1)?.text, error);
    } finally { f.cleanup(); }
  }
});

test("declined or changed uncompacted sessions do not start compaction", async () => {
  for (const scenario of ["declined", "changed", "busy", "pending"] as const) {
    const f = uncompactedFixture();
    try {
      const h = commandHarness(f.sm);
      if (scenario === "declined") h.settings.confirm = false;
      if (scenario === "changed") h.settings.duringConfirm = () => { f.sm.appendCustomEntry("example.state", 1); };
      if (scenario === "busy") h.settings.duringConfirm = () => { h.settings.idle = false; };
      if (scenario === "pending") h.settings.duringConfirm = () => { h.settings.pending = true; };
      await h.run();
      assert.equal(h.compactionCalls(), 0, scenario);
      assert.equal(h.switched(), undefined, scenario);
    } finally { f.cleanup(); }
  }
});

test("successful callback without a saved compaction is not sufficient to prune", async () => {
  const f = uncompactedFixture();
  try {
    const h = commandHarness(f.sm);
    const run = h.run();
    await Promise.resolve();
    h.compaction()!.onComplete!({ summary: "Not saved", firstKeptEntryId: f.kept, tokensBefore: 90000, estimatedTokensAfter: 1000 });
    await run;
    assert.equal(h.switched(), undefined);
    assert.equal(h.compactionCalls(), 1);
    assert.equal(h.notices.at(-1)?.type, "error");
  } finally { f.cleanup(); }
});

test("queued work, busy state or branch movement after compaction stops pruning", async () => {
  for (const scenario of ["pending", "busy", "branch"] as const) {
    const f = uncompactedFixture();
    try {
      const h = commandHarness(f.sm);
      const files = readdirSync(f.sm.getSessionDir());
      const run = h.run();
      await Promise.resolve();
      completeCompaction(f.sm, f.kept, h);
      if (scenario === "pending") h.settings.pending = true;
      if (scenario === "busy") h.settings.idle = false;
      if (scenario === "branch") f.sm.branch(f.compact);
      await run;
      assert.equal(h.switched(), undefined, scenario);
      assert.deepEqual(readdirSync(f.sm.getSessionDir()), files, scenario);
      assert.equal(h.notices.at(-1)?.type, "error", scenario);
    } finally { f.cleanup(); }
  }
});

test("repeated /prune while waiting for compaction does not start a second compaction", async () => {
  const f = uncompactedFixture();
  try {
    const h = commandHarness(f.sm);
    const run = h.run();
    await Promise.resolve();
    await h.run();
    assert.equal(h.compactionCalls(), 1);
    completeCompaction(f.sm, f.kept, h);
    await run;
    assert.ok(h.switched());
  } finally { f.cleanup(); }
});

test("ephemeral sessions fail preflight before any confirmation or compaction", async () => {
  const h = commandHarness(SessionManager.inMemory());
  await h.run();
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.compactionCalls(), 0);
  assert.equal(h.switched(), undefined);
  assert.match(h.notices.at(-1)!.text, /saved session/);
});
