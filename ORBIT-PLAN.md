# Orbit View Plan — Dispatch HUD

> Written by Dispatch, 2026-08-07
> Adapted from Albert's graph view architecture for the Dispatch HUD.

---

## 1. Overview

A new "Orbit" view that becomes the default landing page. Agents arrayed in an orbital pattern around a central orchestrator core. Active agents light up gold. Connection lines (gold, animated) link orchestrator → agent → sub-agent calls. View exceeds viewport with scroll + zoom.

## 2. Nav Restructure

Current nav: Fleet (circle) | Comms | Sessions
New nav order:
1. **Orbit** — current circle icon, default active view (landing)
2. **Fleet** — new tiles icon (grid of 4 squares)
3. **Comms** — existing chat icon
4. **Sessions** — existing grid icon

```html
<div class="nav-item active" data-view="orbit" title="Orbit">
  <!-- current circle icon -->
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>
  </svg>
</div>
<div class="nav-item" data-view="fleet" title="Fleet">
  <!-- tiles icon -->
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/>
    <rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>
  </svg>
</div>
<div class="nav-item" data-view="comms" title="Comms">...</div>
<div class="nav-item" data-view="sessions" title="Sessions">...</div>
```

## 3. Server Changes

### 3.1 Enhanced State Payload

Add an `orbit` object to the existing `buildState()` return value. This avoids a new endpoint — the SSE `state` event already fires on every change.

```js
orbit: {
  agents: fleet.map(a => ({
    id: a.id,
    name: a.name,
    category: a.category,
    status: a.status,           // active | recent | idle | stale
    model: a.model,
    emoji: a.emoji,
    identityName: a.identityName,
    lastActive: a.lastActive,
    sessions: a.sessions,
    tokens: a.tokens,
    // for main: expand topic cards
    topicKey: a.topicKey || null,
    topicLabel: a.topicLabel || null,
  })),
  // Active connections extracted from comms spawn events
  connections: activeComms
    .filter(c => c.kind === 'spawn' || c.kind === 'send')
    .map(c => ({
      from: c.from,           // 'main' or agent id
      to: c.to,               // target agent id
      time: c.time,
      kind: c.kind,           // 'spawn' or 'send'
    })),
  // Sub-agent chains: which sub-agent sessions are active
  subagents: activeWork
    .filter(w => w.isSubagent)
    .map(w => ({
      sessionId: w.sessionId,
      agentId: w.agentId,
      taskDesc: w.taskDesc,
      status: w.status,
    })),
}
```

**No new endpoint needed.** The existing `buildState()` already computes fleet, comms, and activeWork. The orbit object is just a reshaped view of the same data.

## 4. HTML Structure

```html
<!-- Orbit View (new landing view) -->
<div class="view active" id="view-orbit">
  <div class="orbit-container" id="orbit-container">
    <svg id="orbit-svg" xmlns="http://www.w3.org/2000/svg">
      <defs id="orbit-defs"></defs>
      <g id="orbit-content"></g>
    </svg>
  </div>
</div>

<!-- Fleet View (moved to second nav, no longer default) -->
<div class="view" id="view-fleet">
  ...existing fleet content...
</div>
```

The `orbit-container` is the scrollable/zoomable wrapper. `orbit-svg` uses a large viewBox that exceeds the viewport.

## 5. CSS

Adapted from Albert's graph CSS, using the Dispatch HUD's existing color tokens (they're already the same Albert palette).

```css
/* ─── Orbit View ─── */
.orbit-container {
  width: 100%; height: 100%;
  overflow: auto;
  position: relative;
  background: radial-gradient(800px 500px at 50% 40%, var(--cyan-06), transparent 65%),
              repeating-linear-gradient(0deg, var(--cyan-03) 0 1px, transparent 1px 88px),
              repeating-linear-gradient(90deg, var(--cyan-03) 0 1px, transparent 1px 88px);
}
#orbit-svg {
  display: block;
  min-width: 1600px;
  min-height: 1000px;
}

/* Core: arc-reactor */
.ocore { cursor: pointer; }
.ocore-bound { stroke: var(--cyan-25); stroke-width: 1; }
.ocore-ring { fill: none; }
.ocore-ring.r1 { stroke: var(--cyan-16); stroke-width: 1; }
.ocore-ring.r2 { stroke: var(--cyan-25); stroke-width: 1; }
.ocore-ring.r3 { stroke: var(--cyan-45); stroke-width: 1.5; }
.ocore-heart {
  fill: var(--cyan-10); stroke: var(--cyan-hi); stroke-width: 1.5;
  animation: corepulse 4s ease-in-out infinite;
}
.ocore-tri { fill: var(--cyan-hi); }
.ocore-label {
  fill: var(--text); font-family: var(--font); font-size: 17px;
  letter-spacing: 0.3em; font-weight: var(--w-bold);
}
.ocore-sublabel { fill: var(--dim); font-family: var(--font); font-size: 11px; letter-spacing: 0.3em; }
.ocore.working .ocore-heart { fill: var(--gold-10); stroke: var(--gold-hi); animation: nodepulse var(--pulse) ease-in-out infinite; }
.ocore.working .ocore-tri { fill: var(--gold-hi); }
.ocore.working .ocore-ring.r3 { stroke: var(--gold-45); }
.ocore.working .ocore-label { fill: var(--gold-hi); }

/* Orbit rotator */
.orbit-rot {
  transform-box: fill-box; transform-origin: center;
  animation: spin var(--spin-slow) linear infinite;
}
.odot { fill: var(--cyan-hi); }

/* Connector lines */
.olink { stroke: var(--cyan-25); stroke-width: 1; transition: stroke var(--tr-med); }
.olink.hot {
  stroke: var(--gold-hi); stroke-width: 1.8;
  stroke-dasharray: 8 6;
  animation: dashflow 1.1s linear infinite;
  filter: drop-shadow(0 0 3px var(--gold-45));
}

/* Hex agent nodes — state colors match fleet view exactly */
.onode { cursor: pointer; }
.ohex {
  fill: var(--cyan-06); stroke: var(--cyan-45); stroke-width: 1.5;
  transition: stroke var(--tr-med), fill var(--tr-med);
}
.onode:hover .ohex { stroke: var(--cyan-hi); filter: drop-shadow(0 0 5px var(--cyan-45)); }
.onode.unseen .ohex { fill: var(--cyan-03); stroke: var(--cyan-25); }
/* Fleet color mapping (must match agent-card states exactly):
   active  → gold (border, glow, pulse)
   recent  → violet (border, soft glow)
   idle    → cyan-25 (dim, no glow)
   stale   → orange (border, glow, slight opacity)
   completed → not used in orbit (orbit shows live state only) */
.onode.active .ohex {
  fill: var(--gold-10); stroke: var(--gold-hi);
  animation: nodepulse var(--pulse) ease-in-out infinite;
  filter: drop-shadow(0 0 6px var(--gold-45));
}
.onode.recent .ohex {
  fill: var(--violet-12); stroke: var(--violet-45);
  filter: drop-shadow(0 0 4px var(--violet-25));
}
.onode.idle .ohex {
  fill: var(--cyan-06); stroke: var(--cyan-25); opacity: 0.6;
}
.onode.stale .ohex {
  fill: var(--orange-10); stroke: var(--orange-45); opacity: 0.85;
  filter: drop-shadow(0 0 4px var(--orange-45));
}

/* Node labels — state colors match fleet view */
.olabel-name { fill: var(--text); font-family: var(--font); font-size: 14px; font-weight: var(--w-bold); letter-spacing: 0.16em; }
.olabel-class { fill: var(--dim); font-family: var(--font); font-size: 10px; letter-spacing: 0.24em; }
.onode.active .olabel-name { fill: var(--gold-hi); }
.onode.recent .olabel-name { fill: var(--violet); }
.onode.idle .olabel-name { fill: var(--dim); }
.onode.stale .olabel-name { fill: var(--orange); }

/* Section captions */
.osec-cap { fill: var(--dim); font-family: var(--font); font-size: 12px; font-weight: var(--w-bold); letter-spacing: 0.24em; }

/* Category zone tints (subtle background rings) */
.ozone-ring { fill: none; stroke: var(--cyan-03); stroke-width: 1; stroke-dasharray: 2 6; }

/* Zoom/pan controls */
.orbit-controls {
  position: absolute; bottom: var(--s4); right: var(--s4);
  display: flex; flex-direction: column; gap: var(--s1); z-index: 10;
}
.orbit-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel); border: var(--edge); border-radius: var(--radius);
  color: var(--cyan); cursor: pointer; font-size: 18px;
  transition: background var(--tr-fast), color var(--tr-fast);
}
.orbit-btn:hover { background: var(--cyan-10); color: var(--cyan-hi); }
```

## 6. Frontend JS

### 6.1 Layout Algorithm

Adapted from Albert's `graphLayout()` + `packZone()` + `relaxField()`.

```js
var ORBIT_LAYOUT = {
  W: 1600, H: 1000,
  coreX: 800, coreY: 500,
  coreR: 90,
  hexR: 42,
  labelDrop: 52,
  clearTarget: 20,
};

var ORBIT_ZONES = {
  // Upper arc (186° to 354°), split proportionally by population
  // Zone order: producers (west), planner (apex), critics (east), researchers (east)
  // Lower arc (354° to 546° = full bottom) reserved for future ambient
};

function polar(cx, cy, r, deg) {
  var a = deg * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function hexPath(r) {
  var pts = [];
  for (var i = 0; i < 6; i++) {
    var p = polar(0, 0, r, i * 60);
    pts.push(p[0].toFixed(1) + ' ' + p[1].toFixed(1));
  }
  return 'M' + pts.join(' L') + ' Z';
}

// Zone sectors: proportional to population
var ZONE_ORDER = ['producers', 'planners', 'critics', 'researchers'];
var ZONE_CAPTIONS = {
  planners: '// PLANNERS',
  producers: '// PRODUCERS',
  critics: '// CRITICS',
  researchers: '// RESEARCHERS',
};

function zoneSectors(byZone) {
  var sectors = {};
  var keys = ZONE_ORDER.filter(function(k) { return byZone[k] && byZone[k].length; });
  if (!keys.length) return sectors;
  var from = 186;
  var to = 354; // upper arc
  var gap = 7; // dead arc between zones
  var span = (to - from) - gap * (keys.length - 1);
  var weights = keys.map(function(k) { return byZone[k].length + 0.6; });
  var total = weights.reduce(function(a, b) { return a + b; }, 0);
  var cur = from;
  keys.forEach(function(k, i) {
    var w = span * (weights[i] / total);
    sectors[k] = [cur, cur + w];
    cur += w + gap;
  });
  return sectors;
}

// Deterministic per-name jitter (FNV-1a hash)
function hashUnit(name, salt) {
  var s = String(name) + '#' + salt;
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
```

### 6.2 Node Placement + Relaxation

Ring packing (same as Albert): nodes placed in concentric rings within their zone sector, with jitter. Push-apart relaxation prevents overlaps.

### 6.3 SVG Rendering

```js
function renderOrbit(data) {
  var svg = document.getElementById('orbit-content');
  var defs = document.getElementById('orbit-defs');
  
  // Group agents by category
  var byZone = {};
  data.agents.forEach(function(a) {
    var cat = a.category;
    if (!byZone[cat]) byZone[cat] = [];
    byZone[cat].push(a);
  });
  
  var sectors = zoneSectors(byZone);
  var L = ORBIT_LAYOUT;
  
  // Build core
  var core = buildOrbitCore(L);
  // If any agent is active, core is "working"
  var anyActive = data.agents.some(function(a) { return a.status === 'active'; });
  if (anyActive) core.classList.add('working');
  
  // Build nodes
  var placed = [];
  for (var zone in byZone) {
    var sector = sectors[zone];
    if (!sector) continue;
    var nodes = packZone(byZone[zone], sector, L);
    placed = placed.concat(nodes);
  }
  
  // Relax
  relaxField(placed, [coreBox(L)], sectors, L);
  
  // Build links (core → each node)
  var links = placed.map(function(p) {
    return buildLink(L, p);
  });
  
  // Build hot links from connections data
  var hotLinks = {};
  (data.connections || []).forEach(function(c) {
    hotLinks[c.to] = c;
  });
  
  // Render: links first (behind nodes), then nodes
  svg.innerHTML = '';
  links.forEach(function(l) { svg.appendChild(l); });
  placed.forEach(function(p) { svg.appendChild(buildNode(p, L, hotLinks)); });
  svg.appendChild(core);
  
  // Apply active states
  data.agents.forEach(function(a) {
    if (a.status === 'active') {
      var node = svg.querySelector('[data-agent="' + a.id + '"]');
      if (node) node.classList.add('active');
      var link = svg.querySelector('[data-link="' + a.id + '"]');
      if (link) link.classList.add('hot');
    }
  });
}
```

### 6.4 Zoom + Pan

```js
var orbitZoom = 1;
var orbitPanX = 0;
var orbitPanY = 0;

function applyOrbitTransform() {
  var content = document.getElementById('orbit-content');
  content.setAttribute('transform',
    'translate(' + orbitPanX + ',' + orbitPanY + ') scale(' + orbitZoom + ')');
}

// Mouse wheel zoom
document.getElementById('orbit-container').addEventListener('wheel', function(e) {
  e.preventDefault();
  var delta = e.deltaY > 0 ? 0.9 : 1.1;
  orbitZoom = Math.max(0.3, Math.min(3, orbitZoom * delta));
  applyOrbitTransform();
});

// Drag to pan
var dragging = false;
var dragStart = null;
document.getElementById('orbit-container').addEventListener('mousedown', function(e) {
  if (e.target.tagName === 'svg' || e.target === this) {
    dragging = true;
    dragStart = { x: e.clientX - orbitPanX, y: e.clientY - orbitPanY };
  }
});
document.addEventListener('mousemove', function(e) {
  if (!dragging) return;
  orbitPanX = e.clientX - dragStart.x;
  orbitPanY = e.clientY - dragStart.y;
  applyOrbitTransform();
});
document.addEventListener('mouseup', function() { dragging = false; });
```

### 6.5 SSE Integration

Wire into the existing `state` event handler. When orbit view is active, call `renderOrbit(data.orbit)` instead of `renderFleet(data.agents)`.

```js
function scheduleRender(data) {
  // ... existing code ...
  var activeView = document.querySelector('.nav-item.active');
  if (activeView && activeView.getAttribute('data-view') === 'orbit') {
    if (data.orbit) renderOrbit(data.orbit);
  } else if (activeView && activeView.getAttribute('data-view') === 'fleet') {
    renderFleet(data.agents);
  }
  // ... existing comms/work/task rendering ...
}
```

## 7. Sub-Agent Call Chains

When comms show a spawn from 'main' to an agent, and that agent then spawns its own sub-agent, we draw:
1. Core → Agent node (gold hot link)
2. Agent node → Sub-agent node (gold hot link, dashed flow)

Sub-agent nodes appear as smaller hexes near their parent agent, connected by a short link. These are derived from `activeWork[].isSubagent` entries in the state.

## 8. Implementation Phases

### Phase 1: Nav + Static Layout (dev)
- Move Fleet to second nav with tiles icon
- Add Orbit as first nav with circle icon, set as default active view
- Add `#view-orbit` HTML section with SVG container
- Implement layout algorithm (zones, ring packing, relaxation)
- Render static nodes (no animations, no activity states)
- Add orbit CSS (core, hex, links, labels)

### Phase 2: Live Activity (dev)
- Add `orbit` object to `buildState()` return in server.js
- Wire `renderOrbit()` into `scheduleRender()` for state SSE events
- Active agents light up gold (`.onode.active`)
- Active connections draw gold hot links (`.olink.hot`)
- Core goes gold when any agent is active (`.ocore.working`)
- Sub-agent nodes appear near parent agents

### Phase 3: Zoom + Pan (dev)
- Mouse wheel zoom (0.3× to 3×)
- Drag to pan
- Zoom controls (buttons in corner)
- SVG viewBox auto-fit to content bounds

### Phase 4: Polish (dev → QA loop)
- Animations: nodepulse, corepulse, dashflow, gdrift (per-node float)
- Corner telemetry readouts (active agents count, total tokens, daily tokens)
- Section captions (// PRODUCERS, // PLANNERS, etc.)
- Hover tooltips with agent details
- Spoke crossing repair

### Phase 5: QA Review
- QA agent reviews against Albert's styling reference
- Checks: color accuracy, animation timing, label readability, overlap prevention
- Reports issues for dev to fix

## 9. Dev Brief

When spawning the dev agent, include:
1. Read `ORBIT-PLAN.md` first
2. Read Albert's graph CSS at `/tmp/albert/console/public/styles.css` (lines 707-920)
3. Read Albert's app.js graph functions (lines 1490-2200)
4. Current Dispatch HUD: `/home/node/.openclaw/workspace/dispatch-hud/server.js` and `public/index.html`
5. Implement Phase 1 first, then Phase 2, then Phase 3, then Phase 4
6. After each phase, restart the HUD server and verify
7. Don't touch the existing fleet/comms/sessions views — only add the orbit view and restructure nav
8. The orbit view must work with the existing SSE `state` event — no new endpoints

## 10. QA Brief

When spawning the QA agent:
1. Read the orbit plan and Albert's CSS reference
2. Verify: nav order (orbit → fleet → comms → sessions)
3. Verify: orbit is default landing view
4. Verify: agents grouped by category in zones
5. Verify: active agents go gold with pulse
6. Verify: connection lines appear for active spawns
7. Verify: zoom/pan works
8. Verify: no overlap/label collisions
9. Verify: existing fleet/comms/sessions views still work
10. Report issues for dev to fix
