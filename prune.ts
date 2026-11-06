import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

type SessionSource = ExtensionContext["sessionManager"];

export const PRUNE_ENTRY = "pi-prune";

export class CompactionRequiredError extends Error {}

export interface Selection {
  model: { provider: string; id: string };
  thinkingLevel: string;
  activeTools: string[];
}

export interface PrunePlan {
  entries: SessionEntry[];
  parentId: string | null;
  sourceFile: string;
  sourceId: string;
  sourceLeaf: string | null;
  sourceCount: number;
  cwd: string;
  sessionDir: string;
  removed: number;
  contextHash: string;
}

/** Hash one message at a time instead of serializing a whole context into a second large string. */
export function contextHash(messages: readonly unknown[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n");
  return hash.digest("hex");
}

export function planPrune(source: SessionSource): PrunePlan {
  const sourceFile = source.getSessionFile();
  if (!sourceFile || !statSync(sourceFile).isFile()) throw new Error("Prune requires a saved session.");
  if (source.getHeader()?.version !== 3) throw new Error("Unsupported session format; expected version 3.");
  const all = source.getEntries();
  const byId = new Map<string, SessionEntry>();
  for (const entry of all) {
    if (byId.has(entry.id)) throw new Error("Duplicate session entry ID.");
    if (entry.parentId !== null && !byId.has(entry.parentId)) throw new Error("Invalid session ancestry.");
    byId.set(entry.id, entry);
  }
  const branch = source.getBranch();
  const latest = branch.findLast((entry) => entry.type === "compaction");
  if (!latest || latest.type !== "compaction") throw new CompactionRequiredError("Run /compact before /prune.");
  const firstKept = branch.findIndex((entry) => entry.id === latest.firstKeptEntryId);
  if (firstKept < 0 || firstKept > branch.indexOf(latest)) throw new Error("Invalid compaction boundary.");

  const contextIds = new Set(source.buildContextEntries().map((entry) => entry.id));
  const keep = new Set<string>();
  for (const entry of all) {
    // State may be a delta, so retain every custom record, including abandoned branches.
    // Do not guess which tool names or custom types belong to a stateful extension.
    if (contextIds.has(entry.id)) keep.add(entry.id);
    else if (entry.type === "message") {
      if (entry.message.role === "system" || ("details" in entry.message && entry.message.details !== undefined)) {
        keep.add(entry.id);
      }
    } else if (entry.type === "custom_message") {
      if (entry.details !== undefined) keep.add(entry.id);
    } else if (!["compaction", "branch_summary", "context_edit", "label"].includes(entry.type)) {
      keep.add(entry.id);
    }
  }
  // Older compactions can occur inside the retained raw range. Keep their boundary IDs valid too.
  const boundaries = all.filter((entry) => entry.type === "compaction" && keep.has(entry.id));
  for (const entry of boundaries) {
    if (entry.type !== "compaction") continue;
    const boundary = byId.get(entry.firstKeptEntryId);
    if (!boundary) throw new Error("Invalid compaction boundary.");
    if (!keep.has(boundary.id)) {
      keep.add(boundary.id);
      if (boundary.type === "compaction") boundaries.push(boundary);
    }
  }
  for (const entry of all) {
    if ((entry.type === "label" || entry.type === "context_edit") && keep.has(entry.targetId)) keep.add(entry.id);
  }

  // Preserve IDs and file order (opaque extension references and getEntries() replay),
  // but reconnect each retained entry to its nearest retained ancestor. Never flatten branches.
  const nearest = new Map<string, string | null>();
  const entries: SessionEntry[] = [];
  for (const entry of all) {
    const parentId = entry.parentId === null ? null : nearest.get(entry.parentId)!;
    if (keep.has(entry.id)) entries.push({ ...entry, parentId });
    nearest.set(entry.id, keep.has(entry.id) ? entry.id : parentId);
  }
  const sourceLeaf = source.getLeafId();
  if (!sourceLeaf || !nearest.has(sourceLeaf)) throw new Error("Invalid session leaf.");
  const removed = all.length - entries.length;
  if (removed === 0) throw new Error("Nothing to prune after retaining context and state.");
  return {
    entries,
    parentId: nearest.get(sourceLeaf)!,
    sourceFile,
    sourceId: source.getSessionId(),
    sourceLeaf,
    sourceCount: all.length,
    cwd: source.getCwd(),
    sessionDir: source.getSessionDir(),
    removed,
    contextHash: contextHash(source.buildSessionProjection().messages),
  };
}

export function assertUnchanged(source: SessionSource,
  plan: Pick<PrunePlan, "sourceId" | "sourceFile" | "sourceLeaf" | "sourceCount" | "contextHash">): void {
  if (source.getSessionId() !== plan.sourceId || source.getSessionFile() !== plan.sourceFile ||
      source.getLeafId() !== plan.sourceLeaf || source.getEntries().length !== plan.sourceCount ||
      contextHash(source.buildSessionProjection().messages) !== plan.contextHash) {
    throw new Error("Session changed while preparing /prune. Please try again.");
  }
}

/** Write only a new file, using Pi's public JSONL format. Never mutate a live manager or rewrite the archive. */
export function createPrunedSession(plan: PrunePlan, selection: Selection): string {
  const target = SessionManager.create(plan.cwd, plan.sessionDir);
  target.newSession({ parentSession: plan.sourceFile });
  const path = target.getSessionFile()!;
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify(target.getHeader())}\n`);
      for (const entry of plan.entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const prepared = SessionManager.open(path, plan.sessionDir);
    // The source leaf need not be the last physical record after tree navigation.
    if (plan.parentId === null) prepared.resetLeaf();
    else prepared.branch(plan.parentId);
    prepared.appendModelChange(selection.model.provider, selection.model.id);
    prepared.appendThinkingLevelChange(selection.thinkingLevel);
    // Keep the restore marker at the leaf so later resumes never reset tools changed since pruning.
    prepared.appendCustomEntry(PRUNE_ENTRY, { version: 1, activeTools: selection.activeTools });
    if (contextHash(prepared.buildSessionProjection().messages) !== plan.contextHash) {
      throw new Error("Context verification failed; the original session has not been switched.");
    }
    // Verify the serialized copy as well, not only an in-memory reconstruction.
    const reopened = SessionManager.open(path, plan.sessionDir);
    if (contextHash(reopened.buildSessionProjection().messages) !== plan.contextHash) {
      throw new Error("Saved context verification failed.");
    }
    if (statSync(path).size >= statSync(plan.sourceFile).size) {
      throw new Error("Retaining context and state would not make the session smaller.");
    }
    const syncFd = openSync(path, "r+");
    try { fsyncSync(syncFd); } finally { closeSync(syncFd); }
    return path;
  } catch (error) {
    if (created) unlinkSync(path);
    throw error;
  }
}
