# pi-prune

Continue a compacted [Pi](https://pi.dev) session without loading its discarded conversation history.

## Install

```sh
pi install git:github.com/fabiangigler/pi-prune
```

Run `/reload` or restart Pi when you are ready to load the extension.

## Use

Run `/compact` if needed, then `/prune` while Pi is idle. Confirm to switch to a smaller continuation. **The original session is never rewritten or deleted** and remains available through `/resume`; the new session links back to it.

No model call or additional summary is made. The extension verifies the copied session's stored model context before switching: the existing summary, retained messages, context edits, images, and provider signatures stay intact.

Custom entries, system/tool declarations, and messages carrying `details` are conservatively retained, without special-casing any extension. Model/thinking selection and active tools are restored. This can limit size savings. Only the current conversation branch is continued; retained state on other branches stays separate.

Extensions that replay discarded text, reference removed entries, or keep state only in memory may need the original session. Historical navigation and complete usage totals belong to that archive. Startup hooks can change the new session; `/prune` warns if its context or settings differ after switching. It does not guarantee an immediate RSS decrease.

Requires a saved, compacted session and confirmation (TUI or RPC). Tested with Pi 1.4 and 1.5, session format v3. Files stay local; nothing is uploaded.

## Development

```sh
pnpm install --ignore-scripts
pnpm check
pnpm test
```

Tests use synthetic sessions and disable network access in the runtime integration test. No provider calls or credentials are needed.
