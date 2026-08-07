# Orbit View QA Report

> Self-reviewed by Dispatch, 2026-08-07

## ✅ Working Correctly

1. **Nav order**: Orbit (circle, first, active) → Fleet (tiles) → Comms → Sessions ✅
2. **Orbit is default landing**: `class="view active"` on `#view-orbit` ✅
3. **Core arc-reactor**: Concentric rings, orbital dots, pulsing heart, "DISPATCH" label ✅
4. **Core working state**: `.ocore.working` goes gold (heart, ring, label) when any agent active ✅
5. **Connector lines**: `.olink` from core to nodes, `.olink.hot` gold dashed flow ✅
6. **Hex tiles**: `hexPath()` flat-top hexagon with glyph icon and label below ✅
7. **Section captions**: `// PRODUCERS`, `// PLANNERS` etc. in zones ✅
8. **Zone layout**: Upper arc 186°-354°, proportional sectors by population ✅
9. **Ring packing**: Concentric rings within zones, per-node jitter via `hashUnit()` ✅
10. **Push-apart relaxation**: 60-pass relaxation + core avoidance ✅
11. **Zoom/pan**: Mouse wheel (0.3×-3×), click-drag, zoom buttons, reset ✅
12. **Corner telemetry**: Agent count top-left, total tokens bottom-right ✅
13. **SSE integration**: `renderOrbit()` called from `render()` when orbit view active ✅
14. **Existing views**: Fleet, Comms, Sessions HTML untouched ✅
15. **SVG viewBox**: 1600×1000, exceeds viewport, scrollable ✅

## ❌ Issues Found

### 1. Missing fleet state colors for recent/idle/stale nodes
**Severity:** Medium
**Location:** CSS lines ~728-735
**Issue:** CSS only has `.onode.active` and `.onode.unseen` states. Missing `.onode.recent`, `.onode.idle`, `.onode.stale` to match fleet view colors.
**Fix:** Add CSS rules for these states matching the fleet view:
- `.onode.recent` → violet (border, soft glow)
- `.onode.idle` → dim cyan (no glow, lower opacity)
- `.onode.stale` → orange (border, glow, slight opacity)

### 2. Missing label color states for recent/idle/stale
**Severity:** Low
**Issue:** `.olabel-name` only has `.onode.active .olabel-name { fill: gold }`. Missing recent/idle/stale label colors.
**Fix:** Add matching label colors.

### 3. Node class assignment doesn't add `active` class properly
**Severity:** Medium
**Location:** JS line ~1813: `var cls = 'onode ' + st;`
**Issue:** When `st = 'active'`, class becomes `onode active` ✅. But the CSS uses `.onode.active .ohex` (needs both classes on same element). The `<g>` gets `class="onode active"` and the `.ohex` is a child. CSS `.onode.active .ohex` should work because `.onode.active` matches the `<g>` and `.ohex` is a descendant. Actually this is correct ✅ — false alarm.

### 4. `ocore-tri` class defined in CSS but never created in JS
**Severity:** Low
**Issue:** CSS has `.ocore-tri { fill: var(--cyan-hi); }` and `.ocore.working .ocore-tri` but `buildOrbitCore()` never creates a triangle element.
**Fix:** Add a small triangle pointer in the core, or remove the unused CSS.

### 5. `ofloat` drift animation class defined but never applied
**Severity:** Low
**Issue:** CSS has `.ofloat { animation: gdrift 16s ... }` but nodes don't get this class. Albert applies per-node drift. Not critical for v1 but would add organic feel.
**Fix:** Add `ofloat` class to node `<g>` elements with per-node `--drift` CSS variable.

### 6. `ocore-sublabel` CSS exists but no sublabel element created
**Severity:** Low
**Fix:** Either add a sublabel (e.g. "ORCHESTRATOR") or remove unused CSS.

### 7. `ozone-ring` CSS defined but never rendered
**Severity:** Low
**Issue:** Zone tint rings would help visually separate categories.
**Fix:** Draw faint dashed circles at zone boundaries. Defer to polish phase.

## 💡 Suggestions

1. **Add per-node drift**: Apply `.ofloat` class to each node `<g>` with a per-name `--drift` value (2-7px) for the floating feel Albert has.
2. **Add hover tooltips**: Show agent details (status, sessions, tokens, model) on hover.
3. **Add sub-agent nodes**: When comms show a sub-agent spawn, draw a smaller hex near the parent agent with a connecting line.
4. **Add `ocore-tri`**: Small triangle pointer in the core for visual interest.
5. **Spoke crossing repair**: Albert nudges nodes if their connector line crosses another node's label. Would improve readability at higher agent counts.
