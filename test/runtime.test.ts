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

test("real Pi loader and runtime restore the verified session without a provider request", async () => {
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
    sm.appendMessage({ role: "user", content: "Old text ".repeat(10000), timestamp: 2 });
    const kept = sm.appendMessage({ role: "user", content: "Current question", timestamp: 3 });
    sm.appendCompaction("Existing summary", kept, 90000, { readFiles: ["file.ts"] });
    sm.appendCustomEntry("example.store", { set: { a: 1 } });
    sm.appendCustomEntry("example.store", { set: { b: 2 } });
    const before = contextHash(sm.buildSessionProjection().messages);
    const sourceFile = sm.getSessionFile()!;
    const archive = readFileSync(sourceFile);
    const notices: Array<{ text: string; type: string }> = [];
    const errors: unknown[] = [];
    const settingsManager = SettingsManager.inMemory({ defaultProvider: "example", defaultModel: "reasoner", defaultThinkingLevel: "high" });
    const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, settingsManager, modelRuntime: models,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          noContextFiles: true, additionalExtensionPaths: [plugin] },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sm });
    const host = runtime;
    const bind = async () => host.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        confirm: async () => true,
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
    await host.session.prompt("/prune");
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
