# Sessions Page Plan — Dispatch HUD

> Produced by the planner agent, 2026-08-05
> Reviews Albert's session architecture and designs a sessions page for the Dispatch HUD.

---

## 1. Albert Session Architecture Review

### Overview

Albert's console has a dedicated Sessions view with a master-detail layout: a scrollable list of session summaries on the left, and a detail panel on the right showing a timeline of events for the selected session.

### Data Flow

```
Claude Code transcripts (~/.claude/projects/)
        │
        ▼
 session-tailer.mjs          ← tails JSONL files, tracks byte offsets
        │
        ▼
 transcript-adapter.mjs      ← PRIVACY BOUNDARY: parseLine() extracts allowlisted fields only
        │
        ▼
 session-tailer state        ← in-memory Map<sessionId, state>
        │
        ├── toSummary(state)  → REST: GET /api/sessions, /api/sessions/:id
        └── pushEvent(state)  → SSE:  event "session" (live events)
                                 SSE:  event "session-state" (summary updates)
        │
        ▼
 Frontend (app.js)
   normSession()             ← field-by-field rebuild from named fields only
   normSessionEvent()        ← same privacy contract on events
```

### Key Architectural Decisions

1. **No hooks, read-only**: The tailer opens transcript files in read-only mode. It never writes to Claude Code's directories. No hooks in the critical path.

2. **Privacy contract (transcript-adapter.mjs)**: This is the single boundary module. It:
   - Builds every output object from NAMED fields, literally field-by-field
   - NEVER uses spread, Object.assign, or JSON round-trip to copy raw transcript objects
   - NEVER passes through: prompts, message content, tool inputs, tool results, command strings, diffs, attachment bodies
   - ALLOWLIST of fields that may leave: sessionId, cwd, gitBranch, entrypoint, timestamp, type, isSidechain, aiTitle, tool names (not inputs), agent type, description (truncated to 120 chars), result status/duration/tokens, model name, usage token counts
   - `parseLine()` NEVER throws — unrecognized shapes degrade to `kind:'other'`

3. **Session state model** (`toSummary`):
   - `session_id`, `project` (basename of cwd), `cwd`, `git_branch`, `surface` (entrypoint), `title`
   - `started`, `last_activity`, `status` (idle/active/missing)
   - `turns`, `tool_calls`, `dispatches`, `tokens` (main + subagent total)
   - `agents[]` — agentType, count, lastSeen, model
   - `is_harness`, `harness_agents[]` — derived from `loop-*` agent types
   - `compliance.signals[]` — search/tests/docs delegation verdicts
   - `missing` — true if transcript file has been pruned by Claude Code

4. **Session death is inferred**: No explicit SessionEnd signal. `idle` means no new bytes for 10 minutes, not "exited". A missing file is marked `missing` but kept in memory.

5. **Compaction handling**: Claude Code rewrites transcripts in place during compaction. The tailer detects file truncation (size < offset), calls `resetDerived()` to rebuild all counters from zero, and replays the file. During replay, events are NOT re-emitted (prevents duplicate comms), but counters ARE rebuilt.

6. **Subagent attribution**: Subagent transcripts are NEVER read. Instead, `agent-*.meta.json` sidecar files provide agentType, model, spawnDepth, description, toolUseId. This avoids double-counting tokens (subagent usage is already in the parent's dispatch results).

7. **Server endpoints**:
   - `GET /api/sessions` — returns `{ sessions: [...] }` array of summaries, sorted newest-first by `last_activity`
   - `GET /api/sessions/:id` — returns full summary + capped events array (max 500 events)
   - `SSE /events` — emits `init` (with sessions array), then live `session` events and `session-state` updates

8. **Frontend rendering (app.js)**:
   - `normSession()` — rebuilds each session from named fields only (privacy contract's second gate)
   - Sessions sorted newest-first by `last_activity` (ms timestamp)
   - Click a session row → `fetchSessionDetail(id)` → render in right panel
   - Live events via SSE: `ingestSessionEvent()` prepends to feed and detail view
   - `session-state` SSE: upserts summary in place, re-sorts
   - ACTIVITY panel prefetches detail for top 4 active sessions (`ACTIVE_PREFETCH = 4`)
   - Session events have their own badge type (`b-session`) and filter category (`sessions`)

9. **HTML structure** (index.html):
   ```html
   <section id="view-sessions" class="view" aria-label="Sessions">
     <div class="sess-grid">
       <div id="sessionsList" class="panel"></div>
       <div id="sessionsDetail" class="panel"></div>
     </div>
   </section>
   ```
   Two-panel grid: `sess-grid` is a CSS grid with the list on the left and detail on the right.

10. **Compliance signals**: Albert tracks whether the orchestrator delegates search/tests/docs to specialized agents vs. doing them in the main thread. Verdicts: `followed` (delegated > 0 and main ≤ 2× delegated), `ignored` (delegated = 0 and main ≥ 5), `mixed` (everything else), `n/a` (both zero).

---

## 2. Dispatch HUD Sessions Page Design

### 2.1 Adaptation Strategy

The Dispatch HUD already has most of Albert's infrastructure in different form:
- **Session data**: Reads `sessions.json` from ALL agent directories (not Claude Code transcripts)
- **Transcript peeking**: `peekTranscriptTask()` reads first user message for task description
- **Comms scanning**: `scanTranscriptForComms()` reads transcripts for spawn/send/reply events
- **SSE**: Already broadcasts `state` events with sessions, `comms-update` for live comms
- **Transcript watching**: `fs.watch` on active transcripts for real-time updates

The key difference: Albert tails Claude Code's own transcript format. The Dispatch HUD reads OpenClaw's `sessions.json` + JSONL transcripts. The adaptation maps Albert's session model to OpenClaw's data sources.

### 2.2 Server Changes

#### 2.2.1 New Endpoint: `GET /api/sessions`

Returns an array of session summaries across all agents, sorted newest-first.

```js
// server.js — add to HTTP router
if (pathname === '/api/sessions') {
  const summaries = buildSessionSummaries();
  sendJson(res, 200, { sessions: summaries });
  return;
}
```

**Session summary model** (adapted from Albert's `toSummary` to OpenClaw's data):

```js
{
  session_id: string,        // s.sessionId
  key: string,              // full session key (e.g. "agent:main:telegram:group:...")
  agent_id: string,          // s.agentId
  label: string,             // getSessionLabel(s) — human-readable context
  kind: string,              // s.kind — telegram, discord, cron, subagent, main, direct
  project: string|null,     // derived from session key / agent workspace
  status: string,            // active | recent | idle | stale | completed
  started: number|null,      // s.startedAt (ms)
  last_activity: number|null,// s.updatedAt (ms)
  ended: number|null,        // s.endedAt
  runtime_ms: number|null,   // s.runtimeMs
  model: string,             // s.model or derived from modelOverride
  tokens: {                  // token breakdown
    total: number,
    input: number,
    output: number,
    context: number
  },
  turns: number|null,        // derived from transcript scan (if available)
  is_subagent: boolean,      // kind === 'subagent'
  is_heartbeat: boolean,     // last activity was heartbeat poll
  task_desc: string|null,    // from peekTranscriptTask (for subagents)
  parent_session: string|null, // for subagents: parent session ID
}
```

**Implementation**: Reuse existing `loadSessionStore()` data + `peekTranscriptTask()` + `checkHeartbeat()`. No new file I/O needed — just format the data that's already being read.

```js
function buildSessionSummaries() {
  const now_ms = Date.now();
  return Object.values(sessions)
    .map(s => {
      const age = s.updatedAt ? (now_ms - s.updatedAt) : Infinity;
      let status = 'completed';
      if (s.endedAt) status = 'completed';
      else if (age < ACTIVE_THRESHOLD) status = 'active';
      else if (age < RECENT_THRESHOLD) status = 'recent';
      else if (age < STALE_THRESHOLD) status = 'idle';
      else status = 'stale';

      const isSubagent = s.kind === 'subagent' || (s.key && s.key.includes('subagent:'));
      const hbInfo = checkHeartbeat(s.key, s.sessionId);
      
      let taskDesc = null;
      if (isSubagent) {
        const taskInfo = peekTranscriptTask(s.key, s.sessionId);
        taskDesc = taskInfo?.taskDesc || null;
      }

      return {
        session_id: s.sessionId,
        key: s.key,
        agent_id: s.agentId,
        label: getSessionLabel(s),
        kind: s.kind || 'direct',
        status,
        started: s.startedAt || null,
        last_activity: s.updatedAt || null,
        ended: s.endedAt || null,
        runtime_ms: s.runtimeMs || null,
        model: s.model || '',
        tokens: {
          total: s.totalTokens || 0,
          input: s.inputTokens || 0,
          output: s.outputTokens || 0,
          context: s.contextTokens || 0,
        },
        is_subagent: isSubagent,
        is_heartbeat: hbInfo.isHeartbeat,
        task_desc: taskDesc,
      };
    })
    .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
}
```

#### 2.2.2 New Endpoint: `GET /api/sessions/:id`

Returns session detail with a capped events array (transcript-derived timeline).

```js
const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
if (sessionMatch) {
  const id = decodeURIComponent(sessionMatch[1]);
  const detail = buildSessionDetail(id);
  if (!detail) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(detail));
  return;
}
```

**Session detail model**:

```js
{
  // ...all summary fields...
  events: [
    {
      ts: number,           // timestamp (ms)
      type: string,         // 'user-turn' | 'tool-call' | 'dispatch' | 'dispatch-result' | 'reply' | 'comms'
      actor: string,        // agent ID or 'user' or 'main'
      target: string|null,  // for dispatches: target agent
      summary: string,      // short description (truncated)
    }
  ]
}
```

**Implementation**: Reuse `scanTranscriptForComms()` for the events timeline. The comms scanner already extracts spawn/send/reply/user events with timestamps. Cap to 500 events (matching Albert).

```js
function buildSessionDetail(sessionId) {
  // Find session in state
  let session = null;
  let sessionKey = null;
  for (const [key, s] of Object.entries(sessions)) {
    if (s.sessionId === sessionId) {
      session = s;
      sessionKey = key;
      break;
    }
  }
  if (!session) return null;

  // Build summary (reuse buildSessionSummaries logic)
  const summaries = buildSessionSummaries();
  const summary = summaries.find(s => s.session_id === sessionId);
  if (!summary) return null;

  // Build events timeline from transcript
  const agentId = session.agentId || 'main';
  const transcriptPath = findTranscriptFile(agentId, sessionId);
  let events = [];
  if (transcriptPath) {
    // For parent sessions: use comms scan results
    // For subagent sessions: scan their own transcript
    const comms = scanTranscriptForComms(transcriptPath);
    events = comms.slice(0, 500).map(c => ({
      ts: c.time,
      type: c.kind,           // 'spawn' | 'send' | 'user' | 'reply' | 'response' | 'announce'
      actor: c.from,
      target: c.to,
      summary: (c.instruction || '').slice(0, 200),
    }));
  }

  return { ...summary, events };
}
```

#### 2.2.3 SSE: Add `sessions-update` Event

When `buildState()` runs (on file watcher or poll), emit a `sessions-update` event with the full sessions array so the sessions view stays live:

```js
// In broadcastFullState() or alongside it:
async function broadcastSessionsUpdate() {
  if (sseClients.size === 0) return;
  const summaries = buildSessionSummaries();
  broadcast('sessions-update', { sessions: summaries });
}
```

Wire this into `processStoreChange()` after `sessions = result.sessions;`:

```js
// After sessions are updated, broadcast sessions update
broadcastSessionsUpdate();
```

### 2.3 HTML Structure

Add a new view section and wire the existing third nav icon:

```html
<!-- In index.html, add data-view="sessions" to the third nav item -->
<div class="nav-item" data-view="sessions" title="Sessions">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>
  </svg>
</div>

<!-- Add sessions view section after comms view -->
<div class="view" id="view-sessions">
  <div class="sessions-grid">
    <div class="panel sessions-list-panel" id="sessions-list-panel">
      <div class="c4"></div>
      <div class="sessions-list-header">
        <span class="section-title" style="margin:0">Sessions</span>
        <span class="sessions-count" id="sessions-count">0</span>
      </div>
      <div class="sessions-list" id="sessions-list"></div>
    </div>
    <div class="panel sessions-detail-panel" id="sessions-detail-panel">
      <div class="c4"></div>
      <div id="sessions-detail">
        <div class="empty">Select a session to view details</div>
      </div>
    </div>
  </div>
</div>
```

### 2.4 CSS

```css
/* Sessions view */
.sessions-grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: var(--s4);
  height: 100%;
  padding: var(--s4);
  overflow: hidden;
}

.sessions-list-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sessions-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s3) var(--s4);
  border-bottom: var(--edge);
}

.sessions-count {
  font-size: var(--fs-xs);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.sessions-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--s2);
}

.session-row {
  padding: var(--s2) var(--s3);
  margin-bottom: 2px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: background var(--tr-fast);
  border: 1px solid transparent;
}
.session-row:hover {
  background: var(--cyan-06);
  border-color: var(--cyan-16);
}
.session-row.selected {
  background: var(--cyan-10);
  border-color: var(--cyan-45);
}

.session-row-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 2px;
}
.session-row-label {
  font-size: var(--fs-sm);
  font-weight: var(--w-bold);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.session-row-status {
  font-size: var(--fs-xs);
  font-weight: var(--w-bold);
  text-transform: uppercase;
  letter-spacing: var(--track);
}
.session-row-status.active { color: var(--gold-hi); }
.session-row-status.recent { color: var(--violet); }
.session-row-status.idle { color: var(--dim); }
.session-row-status.stale { color: var(--orange); }
.session-row-status.completed { color: var(--green); }

.session-row-meta {
  display: flex;
  gap: var(--s2);
  font-size: var(--fs-xs);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.session-row-meta span { white-space: nowrap; }

.sessions-detail-panel {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#sessions-detail {
  flex: 1;
  overflow-y: auto;
  padding: var(--s4);
}

.session-detail-header {
  margin-bottom: var(--s4);
  padding-bottom: var(--s3);
  border-bottom: var(--edge);
}
.session-detail-title {
  font-size: var(--fs-lg);
  font-weight: var(--w-bold);
  color: var(--cyan-hi);
  margin-bottom: var(--s2);
}
.session-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s3);
  font-size: var(--fs-xs);
  color: var(--dim);
}
.session-detail-meta span {
  display: inline-flex;
  align-items: center;
  gap: var(--s1);
}
.session-detail-meta .meta-label {
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: var(--track);
}
.session-detail-meta .meta-value {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.session-event {
  padding: var(--s3);
  margin-bottom: var(--s2);
  background: var(--bg-page);
  border: 1px solid var(--cyan-06);
  border-radius: var(--radius);
}
.session-event-header {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: var(--s1);
  font-size: var(--fs-xs);
}
.session-event-type {
  display: inline-flex;
  padding: 1px 6px;
  border-radius: var(--radius);
  font-weight: var(--w-bold);
  text-transform: uppercase;
  letter-spacing: var(--track);
  font-size: var(--fs-xs);
}
.session-event-type.spawn { color: var(--gold-hi); border: 1px solid var(--gold-45); background: var(--gold-10); }
.session-event-type.send { color: var(--cyan-hi); border: 1px solid var(--cyan-25); background: var(--cyan-06); }
.session-event-type.user { color: var(--green); border: 1px solid rgba(47,214,123,0.45); background: rgba(47,214,123,0.10); }
.session-event-type.response { color: var(--violet); border: 1px solid var(--violet-45); background: var(--violet-12); }
.session-event-type.reply { color: var(--gold-hi); border: 1px solid var(--gold-45); background: var(--gold-10); }
.session-event-type.announce { color: var(--violet); border: 1px solid var(--violet-25); background: var(--violet-06); }

.session-event-actor { color: var(--gold-hi); font-weight: var(--w-bold); }
.session-event-arrow { color: var(--dim); }
.session-event-target { color: var(--cyan-hi); font-weight: var(--w-bold); }
.session-event-time { color: var(--dim); margin-left: auto; font-variant-numeric: tabular-nums; }
.session-event-summary {
  font-size: var(--fs-sm);
  color: var(--text);
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
  padding: var(--s2);
  background: var(--bg-page);
  border-radius: var(--radius);
  margin-top: var(--s1);
}

@media (max-width: 900px) {
  .sessions-grid { grid-template-columns: 1fr; grid-template-rows: 40% 60%; }
}
```

### 2.5 Frontend JS

Add to the existing `<script>` block in index.html:

```js
// ─── Sessions View ───
var sessionsData = [];
var selectedSessionId = null;

function renderSessionsList(sessions) {
  var el = document.getElementById('sessions-list');
  var countEl = document.getElementById('sessions-count');
  if (!el) return;
  
  countEl.textContent = sessions.length;
  
  if (sessions.length === 0) {
    el.innerHTML = '<div class="empty">No sessions found</div>';
    return;
  }
  
  el.innerHTML = sessions.map(function(s) {
    var cls = s.session_id === selectedSessionId ? 'selected' : '';
    return '<div class="session-row ' + cls + '" data-session-id="' + escapeHtml(s.session_id) + '">' +
      '<div class="session-row-top">' +
        '<span class="session-row-label">' + escapeHtml(s.label || s.agent_id || 'unknown') + '</span>' +
        '<span class="session-row-status ' + s.status + '">' + s.status + '</span>' +
      '</div>' +
      '<div class="session-row-meta">' +
        '<span>' + (s.agent_id || '') + '</span>' +
        '<span>' + fmtTokens(s.tokens.total) + ' tok</span>' +
        '<span>' + ago(s.last_activity) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
  
  // Wire click handlers
  el.querySelectorAll('.session-row').forEach(function(row) {
    row.addEventListener('click', function() {
      var id = row.getAttribute('data-session-id');
      selectedSessionId = id;
      renderSessionsList(sessionsData); // re-render to update selection
      fetchSessionDetail(id);
    });
  });
}

function renderSessionDetail(detail) {
  var el = document.getElementById('sessions-detail');
  if (!el) return;
  
  var metaHtml = [
    '<span><span class="meta-label">Agent:</span> <span class="meta-value">' + escapeHtml(detail.agent_id || '') + '</span></span>',
    '<span><span class="meta-label">Kind:</span> <span class="meta-value">' + escapeHtml(detail.kind || '') + '</span></span>',
    '<span><span class="meta-label">Model:</span> <span class="meta-value">' + escapeHtml(detail.model || '') + '</span></span>',
    '<span><span class="meta-label">Started:</span> <span class="meta-value">' + (detail.started ? new Date(detail.started).toISOString().slice(0,19) + 'Z' : '-') + '</span></span>',
    '<span><span class="meta-label">Last:</span> <span class="meta-value">' + (detail.last_activity ? new Date(detail.last_activity).toISOString().slice(0,19) + 'Z' : '-') + '</span></span>',
    '<span><span class="meta-label">Tokens:</span> <span class="meta-value">' + fmtTokens(detail.tokens.total) + '</span></span>',
    '<span><span class="meta-label">In/Out:</span> <span class="meta-value">' + fmtTokens(detail.tokens.input) + ' / ' + fmtTokens(detail.tokens.output) + '</span></span>',
  ];
  if (detail.is_subagent && detail.task_desc) {
    metaHtml.push('<span><span class="meta-label">Task:</span> <span class="meta-value">' + escapeHtml(detail.task_desc.slice(0, 100)) + '</span></span>');
  }
  
  var eventsHtml = '';
  if (detail.events && detail.events.length > 0) {
    eventsHtml = '<div class="section-title" style="margin-top:var(--s4)">Event Timeline</div>' +
      detail.events.map(function(ev) {
        var typeClass = ev.type || 'spawn';
        return '<div class="session-event">' +
          '<div class="session-event-header">' +
            '<span class="session-event-type ' + typeClass + '">' + escapeHtml(ev.type) + '</span>' +
            '<span class="session-event-actor">' + escapeHtml(ev.actor) + '</span>' +
            (ev.target ? '<span class="session-event-arrow">→</span><span class="session-event-target">' + escapeHtml(ev.target) + '</span>' : '') +
            '<span class="session-event-time">' + ago(ev.ts) + '</span>' +
          '</div>' +
          '<div class="session-event-summary">' + escapeHtml(ev.summary || '') + '</div>' +
        '</div>';
      }).join('');
  } else {
    eventsHtml = '<div class="empty" style="margin-top:var(--s4)">No events recorded</div>';
  }
  
  el.innerHTML = 
    '<div class="session-detail-header">' +
      '<div class="session-detail-title">' + escapeHtml(detail.label || detail.session_id.slice(0, 12)) + '</div>' +
      '<div class="session-detail-meta">' + metaHtml.join('') + '</div>' +
    '</div>' +
    eventsHtml;
}

function fetchSessionDetail(id) {
  fetch('/api/sessions/' + encodeURIComponent(id))
    .then(function(res) { return res.json(); })
    .then(function(detail) { renderSessionDetail(detail); })
    .catch(function() {
      var el = document.getElementById('sessions-detail');
      if (el) el.innerHTML = '<div class="empty">Failed to load session detail</div>';
    });
}

// Fetch sessions list on initial load and on SSE state updates
function fetchSessionsList() {
  fetch('/api/sessions')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      sessionsData = data.sessions || [];
      renderSessionsList(sessionsData);
      // Auto-select first active session if none selected
      if (!selectedSessionId && sessionsData.length > 0) {
        var firstActive = sessionsData.find(function(s) { return s.status === 'active'; });
        if (firstActive) {
          selectedSessionId = firstActive.session_id;
          renderSessionsList(sessionsData);
          fetchSessionDetail(selectedSessionId);
        }
      }
    })
    .catch(function() { /* endpoint not available yet */ });
}
```

### 2.6 Wiring into Existing SSE

Add SSE listener for `sessions-update`:

```js
es.addEventListener('sessions-update', function(e) {
  var data = JSON.parse(e.data);
  sessionsData = data.sessions || [];
  renderSessionsList(sessionsData);
  // If selected session still exists, update its detail
  if (selectedSessionId && sessionsData.find(function(s) { return s.session_id === selectedSessionId; })) {
    fetchSessionDetail(selectedSessionId);
  }
});
```

Also call `fetchSessionsList()` on initial connect, alongside the existing `state` event handler:

```js
// In the 'state' event handler, after scheduleRender(data):
if (sessionsData.length === 0) fetchSessionsList();
```

### 2.7 Nav Wiring

The existing nav click handler in `DOMContentLoaded` already switches views for items with `data-view`. Just add `data-view="sessions"` to the third nav item (already done in HTML above). The existing JS will handle view switching automatically.

---

## 3. Planner Fleet Fix

### Root Cause

In `/home/node/.openclaw/workspace/dispatch-hud/server.js`, `AGENT_CATEGORIES.planners` is an empty array:

```js
const AGENT_CATEGORIES = {
  orchestrator: ['main'],
  planners: [],  // <-- EMPTY
  producers: ['writer', 'dev-lead', 'art-director', 'tax-assistant', 'devops'],
  critics: ['philosopher', 'security-reviewer', 'editor', 'creative-reviewer', 'tax-reviewer'],
  researchers: ['ux-researcher', 'pm-impact-analyst'],
};
```

The `planner` agent is confirmed in `openclaw agents list --json` — it's the 13th agent. It has its own workspace at `/home/node/.openclaw/workspace-planner`.

### Fix

```js
planners: ['planner'],
```

### Other Missing Agents

Comparing `AGENT_CATEGORIES` against the full agent list:

| Agent ID | In Categories? | Notes |
|---|---|---|
| main | ✅ orchestrator | |
| dev-lead | ✅ producers | |
| devops | ✅ producers | |
| security-reviewer | ✅ critics | |
| editor | ✅ critics | |
| writer | ✅ producers | |
| philosopher | ✅ critics | |
| art-director | ✅ producers | |
| creative-reviewer | ✅ critics | |
| tax-assistant | ✅ producers | |
| tax-reviewer | ✅ critics | |
| ux-researcher | ✅ researchers | |
| pm-impact-analyst | ✅ researchers | |
| **planner** | ❌ **MISSING** | Fix: add to `planners` array |

Only `planner` is missing. All other 12 agents are correctly categorized.

---

## 4. Implementation Phases

### Phase 1: Quick Wins (30 min)

1. **Fix planner in fleet**: Add `'planner'` to `planners` array in `AGENT_CATEGORIES`
2. **Add `data-view="sessions"` to the third nav icon** in index.html
3. **Add the `#view-sessions` HTML section** to index.html (empty grid for now)

After Phase 1: The planner agent appears in the fleet, and clicking the sessions nav icon switches to an empty sessions view.

### Phase 2: Server Endpoints (1 hour)

1. **Add `buildSessionSummaries()` function** to server.js — reuse existing `sessions` state, `getSessionLabel()`, `checkHeartbeat()`, `peekTranscriptTask()`
2. **Add `GET /api/sessions` endpoint** to the HTTP router
3. **Add `buildSessionDetail()` function** — reuse `scanTranscriptForComms()` for events timeline
4. **Add `GET /api/sessions/:id` endpoint** to the HTTP router
5. **Add `sessions-update` SSE broadcast** in `processStoreChange()` after sessions update

After Phase 2: The API endpoints exist and return session data. Can be tested with curl.

### Phase 3: Frontend Rendering (1-2 hours)

1. **Add CSS** for sessions grid, list rows, detail panel, event entries
2. **Add `renderSessionsList()` function** — renders session rows with label, status, meta
3. **Add `renderSessionDetail()` function** — renders header + event timeline
4. **Add `fetchSessionDetail()` function** — fetches from `/api/sessions/:id`
5. **Add `fetchSessionsList()` function** — fetches from `/api/sessions`
6. **Wire click handlers** for session row selection
7. **Wire SSE `sessions-update` listener** for live list updates

After Phase 3: Fully functional sessions page with live updates.

### Phase 4: Polish (deferred)

1. **Active session prefetch**: Auto-fetch detail for top 4 active sessions (like Albert's `ACTIVE_PREFETCH`)
2. **Live event prepend**: When an SSE `comms-update` arrives for the selected session, prepend the event to the detail view without a full re-fetch
3. **Session filtering**: Add filter chips by kind (all / telegram / cron / subagent / direct) and status (active / idle / stale)
4. **Token breakdown chart**: Mini bar chart showing input vs output vs context tokens per session
5. **Session search**: Search box to filter sessions by label, agent, or task description
6. **Compliance signals**: If OpenClaw adds delegation tracking, show Albert-style verdicts
7. **Keyboard navigation**: Arrow keys to move through session list
8. **Session export**: Download session detail as JSON

### Phase 5: Advanced (future)

1. **Cross-agent session relationships**: Show parent-child relationships for subagent sessions (which main session spawned which subagent)
2. **Token burn over time**: Daily token chart per session (Albert's `days` map)
3. **Session comparison**: Side-by-side comparison of two sessions
4. **Subagent tree view**: Hierarchical view of spawn chains

---

## Summary

| Area | What to do | Effort |
|---|---|---|
| Planner fix | Add `'planner'` to `planners` array | 1 line |
| Sessions HTML | Add `data-view="sessions"` + view section | 15 min |
| Server API | Two endpoints + SSE event, all reusing existing data/functions | 1 hour |
| Frontend | List + detail rendering, click-to-select, SSE live updates | 1-2 hours |
| Polish | Filters, prefetch, search, charts | Deferred |

The design closely follows Albert's architecture (master-detail layout, event timeline, live SSE updates) but adapts the data model to OpenClaw's existing session store format. Critically, it reuses the infrastructure that's already built — `loadSessionStore()`, `getSessionLabel()`, `peekTranscriptTask()`, `checkHeartbeat()`, `scanTranscriptForComms()`, `findTranscriptFile()` — so the implementation is mostly formatting and wiring, not new data pipelines.
