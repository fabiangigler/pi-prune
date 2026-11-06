# pi-prune

Continue a compacted [Pi](https://pi.dev) session without loading its discarded conversation history.

## Install

```sh
pi install git:github.com/fabiangigler/pi-prune
```

Run `/reload` or restart Pi when you are ready to load the extension.

## Use

Run `/prune` while Pi is idle and confirm. If the current branch has no compaction, Pi first compacts it (a model call that may incur token costs), then automatically prunes after success. Cancellation, failure, or a session too small to compact stops pruning. Already-compacted branches make no model call or new summary.

The extension verifies the copied session's stored model context before switching: the summary, retained messages, context edits, images, and provider signatures stay intact. **The original session is never rewritten or deleted** and remains available through `/resume`; the continuation links back to it. Automatic compaction only appends a summary to the original archive.

Custom entries, system/tool declarations, and messages carrying `details` are conservatively retained, without special-casing any extension. Model/thinking selection and active tools are restored. This can limit size savings. Only the current conversation branch is continued; retained state on other branches stays separate.

Extensions that replay discarded text, reference removed entries, or keep state only in memory may need the original session. Historical navigation and complete usage totals belong to that archive. Startup hooks can change the new session; `/prune` warns if its context or settings differ after switching. It does not guarantee an immediate RSS decrease.

Requires a saved session and confirmation (TUI or RPC). Tested with Pi 1.4 and 1.5, session format v3. Pruning is local; automatic compaction uses Pi's configured model/provider.

## Development

```sh
pnpm install --ignore-scripts
pnpm check
pnpm test
```

Tests use synthetic sessions and disable network access in the runtime integration test. No provider calls or credentials are needed.
