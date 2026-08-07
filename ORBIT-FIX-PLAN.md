# Orbit View Layout Fix — Implementation Plan

## Problem Summary

1. **`zoneSectors()`** distributes agent zones across only a **168° arc** (186°→354°), cramming all agents into the NW→E upper portion, leaving the bottom half empty.
2. **`corePositions`** (inside `renderOrbit()`) lays out multiple orchestrator cores in a **horizontal row** across the center, instead of an inner ring.

## Reference Design

Albert's graph view (https://github.com/Sdraugel/albert/blob/main/assets/graph.png) distributes nodes evenly in a **full 360° circle** around orchestrator cores. Multiple cores are arranged in an **inner circle**, not a horizontal line.

---

## Change 1: `zoneSectors()` — Full 360° Distribution

**Location:** `index.html` line ~1655, function `zoneSectors(byZone)`

### Current (broken):
```js
var from = 186, to = 354, gap = 7;
```

This gives a span of only 168°, all in the upper-right quadrant.

### New implementation:
```js
function zoneSectors(byZone) {
  var sectors = {};
  var keys = ZONE_ORDER.filter(function(k) { return byZone[k] && byZone[k].length; });
  if (!keys.length) return sectors;

  // Full 360° distribution with small gaps between zones
  var gap = 6; // degrees of empty space between adjacent zones
  var totalGap = gap * keys.length; // gap after each zone, including last (wraps around)
  var span = 360 - totalGap;

  // Weight zones by node count (with a small base weight so empty-ish zones still get space)
  var weights = keys.map(function(k) { return byZone[k].length + 0.6; });
  var total = weights.reduce(function(a, b) { return a + b; }, 0);

  // Start at -90° (top/12 o'clock) for visual symmetry — first zone starts at top
  var startDeg = -90;
  var cur = startDeg;
  keys.forEach(function(k, i) {
    var w = span * (weights[i] / total);
    sectors[k] = [cur, cur + w];
    cur += w + gap;
  });
  return sectors;
}
```

### Key decisions:
- **Start at -90° (top center)** — visually balanced, first zone begins at 12 o'clock.
- **`gap = 6°`** between each zone — small enough to maximize space, large enough to visually separate zones. With 4 zones, total gap = 24°, leaving 336° for content.
- **Weights** still proportional to node count, so larger zones get more arc.
- **Full 360°** — no more dead bottom half.

---

## Change 2: `corePositions` — Inner Ring for Multiple Cores

**Location:** `index.html` inside `renderOrbit()`, around line ~1850, where `corePositions` is computed.

### Current (broken):
```js
if (numCores === 1) {
  corePositions.push({ x: W / 2, y: H / 2 });
} else {
  var spacing = W / (numCores + 1);
  for (var i = 0; i < numCores; i++) {
    corePositions.push({ x: spacing * (i + 1), y: H / 2 });
  }
}
```

### New implementation:
```js
// Position cores in an inner ring around the canvas center
var cx = W / 2, cy = H / 2;
var corePositions = [];
if (numCores === 1) {
  corePositions.push({ x: cx, y: cy });
} else {
  // Distribute cores in a small circle around center
  var coreRingR = L.coreR * 1.8; // ring radius for cores
  var coreStep = 360 / numCores;
  var coreStart = -90; // first core at top
  for (var i = 0; i < numCores; i++) {
    var cd = coreStart + i * coreStep;
    var cp = polar(cx, cy, coreRingR, cd);
    corePositions.push({ x: cp[0], y: cp[1] });
  }
}
```

### Key decisions:
- **Single core** stays at center (unchanged behavior).
- **Multiple cores** placed on a ring of radius `coreR * 1.8` (~144px) around the canvas center, distributed at equal angular intervals starting from top.
- With 2 cores: one at top, one at bottom (12 and 6 o'clock).
- With 3 cores: triangle (12, 4, 8 o'clock).
- With 4 cores: square (12, 3, 6, 9 o'clock).

---

## Change 3: Agent Layout Center — Use Canvas Center, Not First Core

**Location:** `index.html` inside `renderOrbit()`, around line ~1875.

### Current:
```js
var mainCore = corePositions[0];
// ... later:
var nodes = packZone(byZone[zone], sector, L, mainCore.x, mainCore.y);
// ... and:
relaxField(placed, L, mainCore.x, mainCore.y);
```

### New:
```js
// Agents orbit the canvas center, not the first core.
// When multiple cores are in an inner ring, agents should surround the entire ring.
var layoutCenter = { x: W / 2, y: H / 2 };
```

Then replace all references to `mainCore.x` / `mainCore.y` in the packing, relaxation, and section caption code with `layoutCenter.x` / `layoutCenter.y`:

```js
var nodes = packZone(byZone[zone], sector, L, layoutCenter.x, layoutCenter.y);
// ...
relaxField(placed, L, layoutCenter.x, layoutCenter.y);
```

And in the section captions block (~line 1937):
```js
var cp = polar(layoutCenter.x, layoutCenter.y, L.coreR + 35, midDeg);
```

### Rationale:
When there's only one core, `layoutCenter` equals the core position, so nothing changes. When there are multiple cores in a ring, agents orbit the *center of the ring*, which is the canvas center. This keeps the 360° distribution symmetric regardless of core count.

---

## Change 4: `relaxField()` — Core Avoidance for Multiple Cores

**Location:** `index.html` function `relaxField()`, around line 1730.

### Current:
```js
// Core avoidance: push radially outward if too close to core
var cd = Math.hypot(placed[i].x - coreX, placed[i].y - coreY);
var minCore = L.coreR + L.hexR + 30;
if (cd < minCore && cd > 0.01) {
  placed[i].r = Math.max(placed[i].r, minCore);
  // ...
}
```

This only pushes away from a single core point. With multiple cores in a ring, agents could overlap with non-primary cores.

### New:
Pass the `corePositions` array into `relaxField` so it can push nodes away from ALL cores.

**Updated signature:**
```js
function relaxField(placed, L, coreX, coreY, corePositions) {
```

**Updated core avoidance block (replace the single-core avoidance inside the loop):**
```js
// Core avoidance: push away from ALL core positions
if (corePositions && corePositions.length) {
  for (var ci = 0; ci < corePositions.length; ci++) {
    var cpos = corePositions[ci];
    var cdx = placed[i].x - cpos.x;
    var cdy = placed[i].y - cpos.y;
    var cd = Math.hypot(cdx, cdy);
    var minCore = L.coreR + L.hexR + 30;
    if (cd < minCore && cd > 0.01) {
      // Push radially outward from this core
      var ang = Math.atan2(cdy, cdx) * 180 / Math.PI;
      placed[i].deg = ang; // snap to the angle away from core
      placed[i].r = Math.max(placed[i].r, minCore);
      var xy = polar(coreX, coreY, placed[i].r, placed[i].deg);
      placed[i].x = xy[0]; placed[i].y = xy[1];
      moved = true;
    }
  }
} else {
  // Fallback: single-core avoidance (original behavior)
  var cd = Math.hypot(placed[i].x - coreX, placed[i].y - coreY);
  var minCore = L.coreR + L.hexR + 30;
  if (cd < minCore && cd > 0.01) {
    placed[i].r = Math.max(placed[i].r, minCore);
    var xy = polar(coreX, coreY, placed[i].r, placed[i].deg);
    placed[i].x = xy[0]; placed[i].y = xy[1];
    moved = true;
  }
}
```

**Updated call site in `renderOrbit()`:**
```js
relaxField(placed, L, layoutCenter.x, layoutCenter.y, corePositions);
```

---

## Change 5: `packZone()` — Adjust Starting Radius for Multi-Core

**Location:** `index.html` function `packZone()`, around line 1680.

### Current:
```js
var r = L.coreR + 100 + ring * (2 * L.hexR + L.clearTarget + 12);
```

### Issue:
The starting radius `L.coreR + 100` (80 + 100 = 180px) is fine for a single core, but when multiple cores are in a ring of radius `coreR * 1.8 = 144px`, the inner ring of agents needs to start farther out to avoid overlapping with the core ring.

### New:
```js
// Base radius accounts for possible multi-core ring
var coreOffset = L.coreR + 100;
// If multiple cores exist, push out by the core ring radius
// (The caller can detect this; packZone itself just needs a larger base)
var r = coreOffset + ring * (2 * L.hexR + L.clearTarget + 12);
```

**However**, rather than changing `packZone`'s signature, the cleaner approach is to adjust `ORBIT_L.coreR` or add a `packBaseR` constant that the caller can adjust. The simplest fix:

Add to `ORBIT_L`:
```js
var ORBIT_L = { W: 2000, H: 1200, coreR: 80, hexR: 44, labelDrop: 58, clearTarget: 32, packOffset: 100 };
```

Then in `packZone`:
```js
var r = L.coreR + L.packOffset + ring * (2 * L.hexR + L.clearTarget + 12);
```

And in `renderOrbit()`, when there are multiple cores, temporarily increase the pack offset:
```js
if (numCores > 1) {
  L = Object.assign({}, ORBIT_L, { packOffset: 100 + L.coreR * 1.8 });
}
```

This ensures the first ring of agents starts at `80 + 100 + 144 = 324px` from center when there are multiple cores, clearing the core ring.

---

## Change 6: `ORBIT_L` Constants — Minor Adjustments

**Location:** `index.html` line ~1626.

### Current:
```js
var ORBIT_L = { W: 2000, H: 1200, coreR: 80, hexR: 44, labelDrop: 58, clearTarget: 32 };
```

### New:
```js
var ORBIT_L = { W: 2000, H: 1200, coreR: 80, hexR: 44, labelDrop: 58, clearTarget: 32, packOffset: 100, coreRingR: 144 };
```

- `packOffset`: configurable base distance from core to first agent ring (currently hardcoded as 100).
- `coreRingR`: radius for multi-core inner ring (`coreR * 1.8` = 144). Used in both `corePositions` computation and `packZone` offset.

---

## Change 7: Link Rendering — Nearest Anchor for All Cores

**Location:** `index.html` inside `renderOrbit()`, around line 1915, the link drawing loop.

### Current code already does this correctly:
```js
for (var ci = 0; ci < corePositions.length; ci++) {
  var cp = corePositions[ci];
  for (var ai = 0; ai < 5; ai++) {
    var ap = polar(cp.x, cp.y, L.coreR, ai * 72 - 90);
    var d = Math.hypot(ap[0] - p.x, ap[1] - p.y);
    if (d < minDist) { minDist = d; nearestAnchor = ap; }
  }
}
```

This already searches all core positions for the nearest anchor. **No change needed.** ✅

---

## Change 8: Section Captions — Adjust Radius for 360° Layout

**Location:** `index.html` around line 1937.

### Current:
```js
var cp = polar(mainCore.x, mainCore.y, L.coreR + 35, midDeg);
```

### New:
```js
var cp = polar(layoutCenter.x, layoutCenter.y, L.coreR + 35, midDeg);
```

Already covered by Change 3 (replacing `mainCore` with `layoutCenter`). Just ensuring it's noted.

**Additional consideration:** With 360° distribution, some section captions will appear at the bottom of the circle. The `osec-cap` CSS class uses `text-anchor: middle`, which is fine. But labels at the very bottom (6 o'clock position) might overlap with nodes. Consider placing captions *outside* the node ring:

```js
// Place captions just inside the first ring of nodes, or outside the core ring
var capR = L.coreR + L.packOffset - 20; // just inside the first agent ring
var cp = polar(layoutCenter.x, layoutCenter.y, capR, midDeg);
```

This keeps captions between the core and the first ring of agents.

---

## Summary of All Changes

| # | Function / Location | What Changes | Lines (approx) |
|---|---|---|---|
| 1 | `zoneSectors()` | Replace 186°→354° arc with full 360° starting at -90° | ~1655-1670 |
| 2 | `corePositions` in `renderOrbit()` | Replace horizontal row with inner ring | ~1850-1865 |
| 3 | `renderOrbit()` agent layout center | Use canvas center (`W/2, H/2`) not `corePositions[0]` | ~1875 |
| 4 | `relaxField()` | Accept `corePositions` array, push from all cores | ~1730-1745 |
| 5 | `packZone()` | Use `L.packOffset` instead of hardcoded 100 | ~1680 |
| 6 | `ORBIT_L` constants | Add `packOffset` and `coreRingR` | ~1626 |
| 7 | Link rendering | No change needed (already correct) | ~1915 |
| 8 | Section captions | Use `layoutCenter`, adjust radius | ~1937 |

---

## Implementation Order

1. **Change 6** — Add new constants to `ORBIT_L`
2. **Change 1** — Rewrite `zoneSectors()` for 360°
3. **Change 2** — Rewrite `corePositions` for inner ring
4. **Change 3** — Add `layoutCenter` and replace `mainCore` references
5. **Change 5** — Update `packZone()` to use `L.packOffset`
6. **Change 4** — Update `relaxField()` for multi-core avoidance
7. **Change 8** — Update section caption positioning

---

## Verification Steps

### Step 1: Single-core, 4 zones with agents
- Open Dispatch HUD orbit view with a normal fleet (producers, planners, critics, researchers).
- **Verify:** Agents are distributed across the full 360° circle, not just the upper-right.
- **Verify:** Each zone occupies a proportional arc with visible gaps between zones.
- **Verify:** Section captions (// PLANNERS, etc.) appear between the core and first agent ring.
- **Verify:** No overlapping nodes (or minimal overlap that `relaxField` resolves).

### Step 2: Multiple cores
- Trigger a view with 2+ orchestrator topic cards.
- **Verify:** Cores are arranged in a small circle around the center, not a horizontal line.
- **Verify:** With 2 cores, they appear at top and bottom.
- **Verify:** With 3 cores, they form a triangle.
- **Verify:** Agent nodes still orbit the center and don't overlap with any core.

### Step 3: Edge cases
- **0 agents:** Should render just the core(s) with no nodes.
- **1 agent:** Should place at the start of its zone sector.
- **Many agents (20+):** Should pack into concentric rings without excessive overlap. `maxRings = 6` cap still applies.
- **1 zone only:** That zone gets the entire 360° minus one gap.

### Step 4: Relaxation stability
- With 15+ agents, verify `relaxField` converges (no infinite oscillation).
- Check that angular-only relaxation preserves ring structure (nodes on the same ring stay on the same ring).
- Verify multi-core avoidance pushes nodes away from ALL cores, not just the primary.

### Step 5: Visual inspection
- Compare the layout side-by-side with the reference design (Albert's graph.png).
- The distribution should look like a full circle, not a half-circle.
- Cores should be clustered at center, agents radiating outward.

### Step 6: Zoom and pan
- Verify zoom in/out, pan, and reset still work after layout changes.
- The `applyOrbitTransform()` function should be unaffected.

---

## Risk Assessment

- **Low risk:** Changes 1, 2, 3, 6, 8 — Pure geometry/positioning math, no structural changes to data flow.
- **Medium risk:** Change 4 (relaxField multi-core) — The angular snapping (`placed[i].deg = ang`) could conflict with the zone-assigned angle. If a node is pushed by core avoidance, it might move out of its zone sector. **Mitigation:** Only snap if the node is very close to a non-primary core (within `minCore` distance). The existing radial push (`placed[i].r = Math.max(...)`) is usually sufficient.
- **Low risk:** Change 5 — Using `L.packOffset` instead of hardcoded `100` is a safe refactor.

## Non-Changes (Confirmed OK)

- **`server.js`** — Data shape is fine, no changes needed.
- **`buildOrbitCore()`** — Builds a single core SVG element, positioning is done by caller. No changes.
- **`hexPath()`, `polar()`, `hashUnit()`, `makeSVG()`** — Utility functions, no changes.
- **CSS** — All orbit CSS classes are layout-agnostic (they style individual elements, not positions). No CSS changes needed.
- **Zoom/pan handlers** — Operate on the SVG transform, independent of node positions. No changes.
