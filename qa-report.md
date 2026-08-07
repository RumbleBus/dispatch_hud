# Dispatch HUD QA Report
**Date:** 2026-07-31 03:11 UTC  
**Reviewer:** QA Subagent (independent pass)  
**Server:** http://localhost:4400

---

## Executive Summary

The HUD is currently **operational** — server is running, SSE stream is delivering data, and the QA script passes 8/9 checks. However, the **root cause of Eric's 404 on refresh has been identified**: the systemd service is inactive (dead) and the current server is a manual process that won't auto-restart.

---

## Server Health

### Current Status: ✅ Running (but fragile)

| Check | Result |
|-------|--------|
| HTTP `/` response | **200 OK** |
| Server PID | 663493 (parent: PID 1) |
| Started | Fri Jul 31 03:10:38 UTC (manual start) |
| SSE `/stream` | ✅ Delivering state events |
| Multiple instances | ❌ Only one instance |
| Port 4400 bound | ✅ Single listener |

### ⚠️ ROOT CAUSE of 404 on Refresh: systemd service is DEAD

```
systemctl status dispatch-hud:
  Active: inactive (dead) since Fri 2026-07-31 02:55:58 UTC
  Main PID: 651747 (code=exited, status=0/SUCCESS)
```

The systemd service was running (PID 651747) and stopped at **02:55:58 UTC** with a **clean exit (status=0)**. The service file has `Restart=on-failure`, which **does not restart on clean exits**. The server was down for ~15 minutes (02:55 → 03:10) until it was manually started again.

**During that window, any refresh would get a connection-refused / 404.**

The current server (PID 663493) was started **manually** via `node server.js`, not through systemd. It's parented to PID 1 but **not managed by systemd**. If this process crashes, it will **not auto-restart**.

### Recommendation
1. **Change `Restart=on-failure` to `Restart=always`** in `dispatch-hud.service` — a clean SIGTERM exit should not leave the service down.
2. **Start via systemd** (`sudo systemctl start dispatch-hud`) instead of manual `node server.js`.
3. Consider adding `RestartSec=3` for faster recovery.

---

## QA Script Results

```
✅ PASS  HUD server responding
✅ PASS  Session count: 138 (matches raw store)
✅ PASS  Active work: 2 items, all valid
✅ PASS  Heartbeat filter: no recent heartbeat sessions to check
✅ PASS  Agent fleet: session counts and tokens match for all 16 agents
✅ PASS  Status derivation: all activeWork statuses correct
✅ PASS  Fleet status: all agent statuses match raw data
⚠️ WARN  Session labels: 3 sessions showing raw kind labels
✅ PASS  Agent staleness: no stale agents detected

Result: 8 PASS, 1 WARN, 0 FAIL
```

---

## Data Accuracy

### Agent Fleet Cards: ✅ Accurate

- **16 agent cards** rendered (15 unique agents + 1 main expanded to 4 topic cards)
- **Model names**: All agents correctly show `openrouter/@preset/glm-5-2` as the model. Older sessions show `unknown` or `@preset/deep-seek-v4-flash` — these are legitimate historical values from the session store, not bugs.
- **Last-active times**: Correctly computed with heartbeat filtering. Agents with no sessions show "never".
- **Token counts**: Match raw session store totals exactly for all agents.
- **Session counts**: Match raw session store counts.

### Orchestrator Topic Cards: ✅ Working (with one label bug)

The main (Dispatch) agent is correctly expanded into **4 topic cards**:

| Topic Label | Status | Last Active | Tokens |
|-------------|--------|-------------|--------|
| main — dispatch direct | recent | 1m ago | 24k |
| Dispatch Topics — Craton Intelligence GTM | idle | 33m ago | 86k |
| cron — World News Digest | idle | 4h ago | 44k |
| telegram — Eric (Direct) (Direct) | idle | 22h ago | 37k |

### 🐛 BUG: Double "(Direct)" in label

The Eric direct session card shows **"telegram — Eric (Direct) (Direct)"** — the word "Direct" appears twice.

**Root cause:** In `topic-names.json`, the user's display name is `"Eric (Direct)"`. The `getSessionLabel()` function appends `" (Direct)"` unconditionally:
```js
if (userName) return 'telegram — ' + userName + ' (Direct)';
```
This produces: `telegram — Eric (Direct) (Direct)`

**Fix:** Either:
- Remove `" (Direct)"` from the `directs` entry in `topic-names.json` (change to just `"Eric"`)
- OR remove the `" (Direct)"` suffix from the `getSessionLabel()` function
- OR check if the username already ends with "(Direct)" before appending

### Active Work Panel: ✅ Accurate

2 active work items showing:
1. **This QA subagent session** — status: active, correct task description extracted from `[Subagent Task]` block
2. **Main dispatch direct session** — status: recent, correct label

### Comms Feed: ✅ Working

Shows 1 comm entry: `main → sub-agent, 16s ago` (the spawn of this QA session).

---

## Session Labels Warning

The QA script flagged **3 sessions with raw kind labels** (not human-readable):

1. `agent:main:cron:addec5bd-...` → shows "cron" (no cron name in topic-names.json)
2. `agent:main:cron:c192811d-...` → shows "cron" (no cron name in topic-names.json)
3. `agent:main:discord:channel:1486559917765693532` → shows "discord" (no discord channel mapping)

These are old sessions (7 days stale) that haven't been active. They show up in the sessions list but not in the fleet or active work panels. **Low priority** — adding entries to `topic-names.json` for these cron jobs and the discord channel would fix the labels.

---

## Visual Issues

### CSS/Layout: ✅ No issues found

- The layout is a standard flexbox app with sidebar nav, header, main panel, and right sidebar
- Agent grid uses `repeat(auto-fill, minmax(200px, 1fr))` — responsive
- Mobile breakpoint at 900px switches to column layout
- Dark theme with proper contrast
- Status colors are well-differentiated (gold=active, purple=recent, orange=stale, faint=idle)

### Minor observations (not bugs):
1. **No favicon** — browsers will request `/favicon.ico` and get a 404, but this doesn't affect the page rendering
2. **SVG `<use href="#...">`** — uses `href` not `xlink:href`. Works in all modern browsers but very old browsers (IE11) would need `xlink:href`. Not a real concern.
3. **SSE reconnection** — 5-second reconnect timer is good. The status dot correctly shows reconnecting state.

---

## Recommendations (Priority Order)

### 🔴 Critical
1. **Fix systemd service restart policy**: Change `Restart=on-failure` to `Restart=always` in `dispatch-hud.service`, then restart via `sudo systemctl restart dispatch-hud`. This ensures the HUD survives clean SIGTERM exits and crashes alike.

### 🟡 Medium
2. **Fix double "(Direct)" label**: Either update `topic-names.json` to change `"Eric (Direct)"` → `"Eric"`, or update `getSessionLabel()` to avoid appending `" (Direct)"` when the username already contains it.
3. **Start server via systemd**: The current manual `node server.js` process (PID 663493) is not managed. After fixing the service file, start with `sudo systemctl start dispatch-hud` and kill the manual process.

### 🟢 Low
4. **Add cron/discord names to topic-names.json**: Add entries for cron IDs `addec5bd-...` and `c192811d-...`, and the discord channel `1486559917765693532` to make session labels fully human-readable.
5. **Add a favicon**: Create a simple SVG favicon to avoid the 404 on `/favicon.ico` (cosmetic only).

---

## Summary

The HUD is functioning correctly with accurate data. Eric's 404 was caused by the systemd service being down (clean exit at 02:55 UTC, not restarted due to `Restart=on-failure` policy). The server was manually restarted at 03:10 UTC. The only code-level bug found is the double "(Direct)" label on Eric's session card. The 3 raw-kind-label warnings are cosmetic and relate to missing entries in `topic-names.json`.
