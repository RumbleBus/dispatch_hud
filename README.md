# Dispatch HUD

Real-time operational dashboard for OpenClaw. Shows live agent state, session monitoring, and inter-agent comms.

**Zero npm dependencies.** Node.js builtins only.

## Requirements

**Chrome** (latest). Thunder lives on the gateway host with Node.js 22.

## Usage

```bash
# Start the HUD server
cd dispatch-hud
node server.js &

# Point chrome to:
# http://127.0.0.1:4400
```

The server reads from gateway session store (`~/.openclaw/agents/main/sessions/sessions.json`) via `fs.watch` with 5s CLI polling fallback (`openclaw sessions list`).

## Architecture

- **`server.js`** — HTTP server serving static files + SSE endpoint at `/stream`
  - Sends full state on connect/reconnect. Emits deltas on `fs.watch`.
  - Polls `openclaw sessions list --json` every 5s as backup.
- **`public/index.html`** — Single-page dashboard (canvas + DOM panels)
  - SSE `state` event (full dump), `session-update` (delta), `gateway-offline`, `version`, `format-error` events
  - Off-focus: agent graph shows green glow for active, cyan for recent, idle for others
  - Task panel shows active sessions.
  - Comms panel shows inter-agent communications (spawn-child relationships).
  - Sessions panel shows all active sessions with token usage.

## Data Flow

1. Gateway writes `sessions.json` → `fs.watch` detects change
2. HUD server re-reads, parses, diffs by `updatedAt` per session key
3. Only changed/sessions emitted as SSE `session-update` events
4. Browser renders updates via canvas + DOM panels

On reconnect: full state dump (client may have missed changes).

If gateway is offline: HUD shows "GATEWAY OFFLINE" overlay with restart instruction.

If OpenClaw format drift is detected (missing expected fields): HUD shows error banner.

## Port

4400. If port is already in use, the server fails with a clear message. The port is local-only and shouldn't conflict.

## What it shows

- **Fleet panel** — all 13 configured agents with status (active/idle/recent/completed)
- **Comms feed** — inter-agent dispatch communications (spawn-child triggers)
- **Task panel** — active sessions shown as running tasks
- **Sessions** — all sessions with token usage, agent ID, age
- **Agent graph** — visual layout of agents by role (producer/critic/maintainer/operator)

## Version tracking

Tracks `runtimeVersion` from `openclaw status --json`. If drift is detected (missing expected fields, unexpected structure), the HUD shows an error banner.

## Future

Phase 4 will design an Albert-style orchestration blueprint — task planning, dependency ordering, model tier assignment, independent verification, gated merges. See `orchestration-blueprint.md` when ready.