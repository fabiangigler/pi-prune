import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime,
  SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { contextHash } from "../prune.ts";

for (const scenario of ["existing", "automatic", "cancelled", "aborted", "too-small"] as const) {
test(`real Pi loader and runtime: ${scenario} compaction, no provider request`, { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-prune-runtime-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const plugin = join(directory, "plugin");
  mkdirSync(plugin);
  for (const file of ["index.ts", "prune.ts", "package.json"]) {
    copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(plugin, file));
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is disabled in this test"); };
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    models.registerProvider("example", {
      api: "openai-responses", baseUrl: "https://example.invalid", apiKey: "test-only",
      models: [{ id: "reasoner", name: "Example", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const sm = SessionManager.create(cwd, join(directory, "sessions"));
    sm.appendModelChange("example", "reasoner");
    sm.appendThinkingLevelChange("high");
    sm.appendMessage({ role: "system", content: "Initial instructions", timestamp: 1,
      toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }] });
    if (scenario !== "too-small") sm.appendMessage({ role: "user", content: "Old text ".repeat(10000), timestamp: 2 });
    const kept = sm.appendMessage({ role: "user", content: "Current question", timestamp: 3 });
    if (scenario === "existing") sm.appendCompaction("Existing summary", kept, 90000, { readFiles: ["file.ts"] });
    sm.appendCustomEntry("example.store", { set: { a: 1 } });
    sm.appendCustomEntry("example.store", { set: { b: 2 } });
    let before = contextHash(sm.buildSessionProjection().messages);
    const sourceFile = sm.getSessionFile()!;
    let archive = readFileSync(sourceFile);
    const originalArchive = archive;
    let compactions = 0;
    let confirmations = 0;
    let started!: () => void;
    const compactionStarted = new Promise<void>((resolve) => { started = resolve; });
    const notices: Array<{ text: string; type: string }> = [];
    const errors: unknown[] = [];
    const settingsManager = SettingsManager.inMemory({ defaultProvider: "example", defaultModel: "reasoner", defaultThinkingLevel: "high",
      compaction: { keepRecentTokens: scenario === "too-small" ? 20000 : 0 } });
    const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, settingsManager, modelRuntime: models,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          noContextFiles: true, additionalExtensionPaths: [plugin], extensionFactories: [(pi) => {
            pi.on("session_before_compact", async (event) => {
              compactions++;
              if (scenario === "cancelled") return { cancel: true };
              if (scenario === "aborted") {
                started();
                await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
              } else assert.equal(scenario, "automatic", "Existing compactions must never be repeated");
              return { compaction: { summary: "Synthetic summary", firstKeptEntryId: kept, tokensBefore: 90000 } };
            });
            pi.on("session_compact", (_event, ctx) => {
              before = contextHash(ctx.sessionManager.buildSessionProjection().messages);
              archive = readFileSync(sourceFile);
            });
          }] },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sm });
    const host = runtime;
    const bind = async () => host.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        confirm: async () => { confirmations++; return true; },
        notify: (text: string, type: string) => { notices.push({ text, type }); },
      } as unknown as ExtensionUIContext,
      commandContextActions: {
        waitForIdle: () => host.session.waitForIdle(),
        newSession: (options) => host.newSession(options),
        switchSession: (path, options) => host.switchSession(path, options),
        fork: (id, options) => host.fork(id, options),
        navigateTree: (id, options) => host.session.navigateTree(id, options),
        reload: async () => { throw new Error("Unexpected reload"); },
      },
      onError: (error) => { errors.push(error); },
    });
    host.setRebindSession(bind);
    await bind();
    assert.equal(host.services.resourceLoader.getExtensions().errors.length, 0);
    const run = host.session.prompt("/prune");
    if (scenario === "aborted") {
      await compactionStarted;
      host.session.abortCompaction();
    }
    await run;
    assert.equal(confirmations, 1);
    if (scenario === "cancelled" || scenario === "aborted" || scenario === "too-small") {
      assert.equal(host.session.sessionFile, sourceFile);
      assert.deepEqual(readFileSync(sourceFile), originalArchive);
      assert.equal(notices.at(-1)?.type, "error", JSON.stringify(notices));
      assert.match(notices.at(-1)!.text, scenario === "too-small" ? /too small/i : /cancelled/i);
      assert.equal(compactions, scenario === "too-small" ? 0 : 1);
      assert.deepEqual(errors, []);
      return;
    }
    assert.equal(compactions, scenario === "automatic" ? 1 : 0);
    assert.deepEqual(archive.subarray(0, originalArchive.length), originalArchive);
    assert.notEqual(host.session.sessionFile, sourceFile, JSON.stringify(notices));
    assert.equal(contextHash(host.session.sessionManager.buildSessionProjection().messages), before);
    assert.deepEqual(host.session.getActiveToolNames(), ["read"]);
    assert.equal(host.session.model?.provider, "example");
    assert.equal(host.session.model?.id, "reasoner");
    assert.equal(host.session.thinkingLevel, "high");
    assert.deepEqual(readFileSync(sourceFile), archive);
    assert.deepEqual(errors, []);
    assert.equal(notices.at(-1)?.type, "info", JSON.stringify(notices));
    const copiedFile = host.session.sessionFile!;
    await host.newSession();
    await host.switchSession(copiedFile);
    assert.equal(contextHash(host.session.sessionManager.buildSessionProjection().messages), before);
    assert.deepEqual(host.session.getActiveToolNames(), ["read"]);
  } finally {
    await runtime?.dispose();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
}
