# Dispatch HUD QA Report v2

> Independent review by Dispatch, 2026-08-07
> Files reviewed: server.js (67KB, 1994 lines), public/index.html (81KB, ~2000 lines), qa.js, verify.sh

---

## Critical

### 1. Duplicate `sessions-update` listener on every reconnect
**File:** public/index.html, lines 1596 and 1613
**Issue:** The `sessions-update` SSE listener is added twice — once directly on the `es` EventSource (line 1596), and again inside the wrapped `connect()` function (line 1613) which runs on every reconnect. Each reconnect adds another listener to the new EventSource. After 5 reconnects, the same event triggers 6 handlers, causing redundant `renderSessionsList()` calls and duplicate `fetchSessionDetail()` fetches.
**Fix:** Remove the listener at line 1596 (the one outside the wrapped connect). Keep only the one inside the wrapped `connect()` so it's re-attached fresh on each new EventSource.

### 2. `buildState` returns null when already in progress, silently dropping updates
**File:** server.js, line 1104
**Issue:** When `buildInProgress` is true, `buildState()` returns `null` immediately. The caller (`broadcastFullState`) checks for null and does nothing. If a transcript watcher fires while a session-store change is already being processed, that comms update is silently lost. The next update won't pick it up unless another file change triggers it.
**Fix:** Queue a single pending rebuild instead of dropping it. Set a `pendingRebuild` flag and check it in the `finally` block — if set, clear it and recurse once.

---

## High

### 3. XSS via `innerHTML` in corner telemetry (low risk, but unsanitized)
**File:** public/index.html, lines 1940, 1944
**Issue:** `tlEl.innerHTML` and `brEl.innerHTML` are built with string concatenation using `ac` (agent count) and `agents.length`. These are integers so the risk is theoretical, but if the data structure ever changes to include string values, this becomes an XSS vector. The rest of the codebase uses `escapeHtml()` for innerHTML inserts.
**Fix:** Use `textContent` for the numeric values, or wrap in `escapeHtml()` for consistency.

### 4. `Math.max(...[])` returns `-Infinity` on empty arrays
**File:** server.js, lines 859, 1555, 1627
**Issue:** `Math.max(...t.agentList.map(a => a.count), 0)` includes the `0` fallback, so line 859 is safe. But lines 1555 and 1627 do `Math.max(...cached.comms.map(c => c.time || 0))` and `Math.max(...fresh.map(c => c.time || 0))` without a `0` fallback. If the array is empty, `Math.max()` returns `-Infinity`, which becomes `lastCommsSentTime` and breaks the freshness filter — all comms would be considered "fresh" on next scan.
**Fix:** Add `, 0` as a fallback argument: `Math.max(...arr.map(...), 0)`.

### 5. `commsCache` cleared on every session store change
**File:** server.js, line 1489
**Issue:** `processStoreChange()` sets `commsCache = {}` (full wipe) on every session store change. Session stores change frequently (every agent turn, every heartbeat). This means every `buildState()` call after a store change re-scans ALL transcripts from scratch, even if the transcripts themselves haven't changed. This is the most likely cause of CPU spikes during active multi-agent work.
**Fix:** Don't clear the whole commsCache. The `scanTranscriptForComms` function already checks `mtime` and returns cached results if unchanged. The cache wipe is unnecessary — the mtime check handles staleness. Remove `commsCache = {}` from `processStoreChange()`.

### 6. Document-level `mousemove`/`mouseup` listeners never removed
**File:** public/index.html, lines 1972, 1978
**Issue:** The orbit pan handlers add `document.addEventListener('mousemove', ...)` and `document.addEventListener('mouseup', ...)` inside an IIFE that runs once on page load. These are permanent document-level listeners. They check `if (!dragging) return` so they're no-ops when not dragging, but they're still called on every mouse movement across the entire page, adding minor overhead to all interactions.
**Fix:** Low priority since the `dragging` guard makes them cheap. If you want to be clean, attach them only on `mousedown` and remove on `mouseup`.

---

## Medium

### 7. `ago()` strings computed server-side, go stale until next SSE push
**File:** server.js, lines 1163, 1622
**Issue:** Comms entries include `c.ago = ago(c.time)` computed at build time on the server. If no new SSE event arrives for 30 seconds, the "2s ago" text becomes "32s ago" but the UI still shows "2s ago". The client has an `agoTimer` that updates the `#updated-ago` element, but it only updates the header timestamp, not individual comms/task timestamps.
**Fix:** Either (a) recompute `ago` values client-side in the `agoTimer` interval, or (b) send relative timestamps as raw ms and format them on the client. Option (b) is cleaner.

### 8. `isNoiseReply` regex catches legitimate replies starting with common words
**File:** server.js, line 423
**Issue:** The regex `/^(now |let me |good |done |found |better |spawns |the )/i` filters out assistant replies that start with these words. But legitimate replies like "Good question, here's what I found..." or "Done. I've written the plan to..." would be filtered out of the comms feed. The intent is to catch internal narration, but the net is too wide.
**Fix:** Tighten the regex to match only the specific narration patterns observed, e.g. `/^(now let me|let me check|let me read|good call|done\.|found it|better approach)/i` or better yet, use a different signal (like checking if the reply is a tool-call-only turn with no user-facing text).

### 9. `firstSpawn` initialized to `Infinity`, can leak into payload if no spawns have time
**File:** server.js, line 840
**Issue:** `tasks[parentId].firstSpawn` is set to `c.time || Infinity` on first spawn. If `c.time` is 0 or null, it stays as `Infinity`. The fallback at line 841 (`if (tasks[parentId].firstSpawn === Infinity) tasks[parentId].firstSpawn = c.time || 0`) catches this, but `elapsed(Infinity)` would produce a huge number if it somehow slipped through.
**Fix:** Initialize `firstSpawn` to `c.time || 0` instead of `Infinity` and use `Math.min` for subsequent spawns.

### 10. SSE `res.once('drain')` handler accumulates on backpressure
**File:** server.js, line 1430
**Issue:** In `sseSend()`, when `res.write()` returns false (backpressure), a `once('drain')` listener is added. If the client is slow and many events fire, multiple `once('drain')` handlers queue up. Each is one-shot so they won't leak indefinitely, but they're still wasteful.
**Fix:** Use a flag to track if a drain handler is already pending. Skip adding a new one if already waiting.

### 11. `peekTranscriptTask` only reads first 8KB of transcript
**File:** server.js, line 340
**Issue:** The function reads the first 8KB to find the `[Subagent Task]` marker. If the transcript starts with a large system prompt or conversation context (which OpenClaw injects), the first user message with the task description may be beyond 8KB. This would cause the task description to come back as `null`, showing "(no task description found)" in the HUD.
**Fix:** Increase to 32KB or scan the first N lines instead of a byte limit. Transcripts are JSONL so line-based scanning is natural.

---

## Low

### 12. `CORS: *` on SSE endpoint allows any origin to connect
**File:** server.js, line 1876
**Issue:** `Access-Control-Allow-Origin: *` on the SSE endpoint means any website can connect to the HUD stream. Since the HUD is on Tailscale only, this is low risk, but if the port is ever exposed publicly, any website could read all session data.
**Fix:** Restrict to known origins or remove the header entirely since the HUD is same-origin (served from the same server).

### 13. `heartbeatCache` not evicted
**File:** server.js, line 321
**Issue:** `heartbeatCache` is written to but never evicted. Unlike `commsCache` and `taskBoardCache` which have `evictCache()` calls in `buildState()`, `heartbeatCache` grows unbounded. Each entry is small (~100 bytes) and entries are keyed by sessionId so growth is bounded by total sessions, but it's still a gap.
**Fix:** Add `evictCache(heartbeatCache, 200)` in `buildState()` alongside the other eviction calls.

### 14. `taskCache` not evicted
**File:** server.js, line 65
**Issue:** Same as heartbeatCache — `taskCache` is written but never evicted. Entries are keyed by sessionId and are small, but there's no cap.
**Fix:** Add `evictCache(taskCache, 200)` in `buildState()`.

### 15. `formatError` is a global that can get stuck
**File:** server.js, line 58
**Issue:** `formatError` is set to `null` when sessions load successfully (line 1091) but only set to a truthy value in `loadSessionStore()` on parse error. If the session store has a transient parse error and then recovers, `formatError` is correctly cleared. But if `loadSessionStore()` returns `{ exists: false }` (gateway offline), `formatError` stays at whatever it was before — it's not explicitly set to an offline message.
**Fix:** Set `formatError` explicitly in all branches of `loadSessionStore()`.

### 16. `connect()` wrapping is fragile
**File:** public/index.html, lines 1611-1620
**Issue:** The code wraps `connect()` by saving `_origConnect` and overriding `connect`. This is a monkey-patch that assumes `connect` is a simple function. If `connect` is ever refactored to use closures or parameters, this wrapping breaks silently.
**Fix:** Move the `sessions-update` listener into the main `connect()` function body directly.

---

## Info

### 17. Orbit and fleet state colors are consistent
The self-review flagged missing orbit state colors as a bug. This has been fixed. All four states (active/recent/idle/stale) have matching CSS rules in both `.agent-card.*` and `.onode.*` selectors with consistent color variables (gold/violet/cyan-25/orange).

### 18. Path traversal protection is adequate
- Static files: `path.resolve()` + `startsWith()` check (line 1909)
- Sessions API: explicit `..` and `/` and `\\` rejection (line 1862)
- Transcript file lookups: use `findTranscriptFile()` which constructs paths from `AGENTS_DIR` + agent ID + sessionId, and sessionId comes from the session store (not user input)

### 19. SSE keepalive is correct
15-second `: ping` comment lines, which is the standard SSE keepalive pattern. Connection cleanup on `req.on('close')` is correct.

### 20. `scheduleRender` correctly throttles with `requestAnimationFrame`
The render throttling pattern (pendingData + renderScheduled flag + rAF) is correct and prevents render thrashing from rapid SSE events.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 4 |
| Medium | 5 |
| Low | 5 |
| Info | 4 |

**Top 3 to fix now:**
1. Remove duplicate `sessions-update` listener (Critical #1) — causes duplicate renders on every reconnect
2. Remove `commsCache = {}` wipe in `processStoreChange` (High #5) — causes full transcript rescans on every session store change, likely the main CPU bottleneck
3. Queue pending rebuild instead of dropping (Critical #2) — silently loses comms updates during active multi-agent work
