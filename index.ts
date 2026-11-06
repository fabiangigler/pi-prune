import { unlinkSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertUnchanged, CompactionRequiredError, contextHash, createPrunedSession, planPrune, PRUNE_ENTRY, type PrunePlan } from "./prune.ts";

export default function pruneExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.type !== "custom" || leaf.customType !== PRUNE_ENTRY) return;
    const data = leaf.data as { version?: unknown; activeTools?: unknown } | undefined;
    if (data?.version === 1 && Array.isArray(data.activeTools) && data.activeTools.every((name) => typeof name === "string")) {
      pi.setActiveTools(data.activeTools);
    }
  });

  let running = false;
  pi.registerCommand("prune", {
    description: "Continue with the same compacted context in a smaller session; keep the original archive",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /prune", "error"); return; }
      if (!ctx.hasUI) { ctx.ui.notify("/prune requires a confirmation dialog.", "error"); return; }
      if (running || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait until Pi is idle and its message queue is empty.", "warning");
        return;
      }
      let current: ExtensionCommandContext = ctx;
      let prepared: string | undefined;
      let switching = false;
      running = true;
      try {
        if (!ctx.model) throw new Error("Select an available model before pruning.");
        const selection = {
          model: { provider: ctx.model.provider, id: ctx.model.id },
          thinkingLevel: pi.getThinkingLevel(),
          activeTools: pi.getActiveTools(),
        };
        const assertReady = () => {
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Pi is no longer idle. Please try again.");
          if (pi.getThinkingLevel() !== selection.thinkingLevel || ctx.model?.id !== selection.model.id ||
              ctx.model?.provider !== selection.model.provider ||
              JSON.stringify(pi.getActiveTools()) !== JSON.stringify(selection.activeTools)) {
            throw new Error("Model or tool settings changed. Please try again.");
          }
        };
        let plan: PrunePlan;
        let compacted = false;
        try {
          plan = planPrune(ctx.sessionManager);
        } catch (error) {
          if (!(error instanceof CompactionRequiredError)) throw error;
          const before = {
            sourceId: ctx.sessionManager.getSessionId(), sourceFile: ctx.sessionManager.getSessionFile()!,
            sourceLeaf: ctx.sessionManager.getLeafId(), sourceCount: ctx.sessionManager.getEntries().length,
            contextHash: contextHash(ctx.sessionManager.buildSessionProjection().messages),
          };
          if (!await ctx.ui.confirm("Compact and prune?",
            "Compact first (model call; may incur costs), then prune.\nOriginal archive kept (/resume).")) return;
          assertReady();
          assertUnchanged(ctx.sessionManager, before);
          ctx.ui.notify("Compacting before pruning...", "info");
          await new Promise<void>((resolve, reject) => {
            ctx.compact({ onComplete: () => resolve(), onError: reject });
          });
          assertReady();
          plan = planPrune(ctx.sessionManager);
          if (plan.sourceId !== before.sourceId || plan.sourceFile !== before.sourceFile ||
              !ctx.sessionManager.getBranch().some((entry) => entry.id === before.sourceLeaf)) {
            throw new Error("Session or branch changed during compaction. Pruning stopped.");
          }
          compacted = true;
        }
        if (!compacted && !await ctx.ui.confirm("Prune session?",
          "Continue with the same context in a smaller session?\nOriginal archive kept (/resume).")) return;
        assertReady();
        assertUnchanged(ctx.sessionManager, plan);
        prepared = createPrunedSession(plan, selection);
        assertUnchanged(ctx.sessionManager, plan);
        switching = true;
        const result = await ctx.switchSession(prepared, {
          withSession: async (next) => {
            current = next;
            const sameContext = contextHash(next.sessionManager.buildSessionProjection().messages) === plan.contextHash;
            const sameModel = next.model?.provider === selection.model.provider && next.model?.id === selection.model.id;
            const sameThinking = next.thinkingLevel === selection.thinkingLevel;
            const sameTools = JSON.stringify(next.getSystemPromptOptions().selectedTools) === JSON.stringify(selection.activeTools);
            if (!sameContext || !sameModel || !sameThinking || !sameTools) {
              next.ui.notify("The copy was verified, but startup extensions or settings changed the restored session. The original is available through /resume.", "warning");
            } else {
              next.ui.notify(`Pruned ${plan.removed} historical records. Original archive preserved.`, "info");
            }
          },
        });
        if (result.cancelled) {
          unlinkSync(prepared);
          ctx.ui.notify("Prune cancelled; the original session is still active.", "info");
        }
      } catch (error) {
        // A failed switch can already have replaced the runtime. Never delete its file.
        if (prepared && !switching) unlinkSync(prepared);
        const message = error instanceof Error ? error.message : "Prune failed.";
        try { current.ui.notify(message, "error"); }
        catch { console.error("Prune stopped after a session change; no session archive was deleted."); }
      } finally {
        running = false;
      }
    },
  });
}
