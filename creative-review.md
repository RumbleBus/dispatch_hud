# Dispatch HUD — Creative Design Review

**Reference:** Albert admin console screenshot
**Reviewed:** `dispatch-hud/public/index.html` (inline CSS)
**Date:** 2026-07-31

---

## Executive Summary

The HUD is 80% of the way to Albert's aesthetic. The main gaps are:

1. **Background not dark enough** — current `#0a1424` needs to drop to `#060d18` or darker
2. **Missing corner registration brackets** on cards — Albert's signature visual element
3. **Missing central radial gradient** behind icon areas
4. **Card backgrounds too opaque** — Albert uses translucent panels
5. **Text colors slightly off** — Albert's primary text is brighter/whiter

Below are exact, implementable CSS changes with specific values.

---

## 1. Color Palette Comparison

| Token | Current Value | Albert Value | Change Needed |
|---|---|---|---|
| `--bg` | `#0a1424` | `#060d18` | **Darker.** Drop to `#060d18` or even `#040a14` |
| `--bg-panel` | `#0d1a2e` | `#080f1c` | Darken to `#080f1c` |
| `--bg-card` | `#0f1d33` | `rgba(15, 30, 53, 0.5)` | **Make translucent.** Use `rgba(15, 30, 53, 0.5)` |
| `--bg-card-hover` | `#12223a` | `rgba(20, 38, 65, 0.6)` | Use `rgba(20, 38, 65, 0.6)` |
| `--bg-sidebar` | `#0b1628` | `#060d18` | Match main bg |
| `--border` | `#1a3050` | `#1E3A5F` | Slightly more blue: `#1e3a5f` |
| `--border-cyan` | `#00d4ff` | `#00D4E4` | Close — shift from `#00d4ff` to `#00d4e4` (more teal) |
| `--text` | `#c8d6e5` | `#E8F4F8` | **Brighten** to `#e8f4f8` |
| `--text-dim` | `#6b8299` | `#5A7A9A` | Close — adjust to `#5a7a9a` (more blue) |
| `--text-faint` | `#3d5a73` | `#3A5A7A` | Close — adjust to `#3a5a7a` |
| `--gold` | `#f5c518` | `#E8B84C` | Shift from bright yellow to amber: `#e8b84c` |
| `--gold-glow` | `rgba(245,197,24,0.15)` | `rgba(232,184,76,0.15)` | Match new gold |
| `--purple` | `#9b6dff` | `#A78BFA` | Shift to `#a78bfa` |
| `--orange` | `#ff6b4a` | `#F97316` | Adjust to `#f97316` |

### Updated `:root` block

```css
:root {
  --bg: #060d18;
  --bg-panel: #080f1c;
  --bg-card: rgba(15, 30, 53, 0.5);
  --bg-card-hover: rgba(20, 38, 65, 0.6);
  --bg-sidebar: #060d18;
  --border: #1e3a5f;
  --border-cyan: #00d4e4;
  --text: #e8f4f8;
  --text-dim: #5a7a9a;
  --text-faint: #3a5a7a;
  --gold: #e8b84c;
  --gold-glow: rgba(232,184,76,0.15);
  --purple: #a78bfa;
  --purple-glow: rgba(167,139,250,0.1);
  --teal: #2dd4bf;
  --teal-glow: rgba(45,212,191,0.08);
  --orange: #f97316;
  --orange-glow: rgba(249,115,22,0.12);
  --cyan: #00d4e4;
  --amber: #e8b84c;
  --red: #ef4444;
  --green: #22c55e;
  --font: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'IBM Plex Mono', 'Consolas', monospace;
}
```

---

## 2. Registration Corner Brackets (NEW — Missing Feature)

**Albert's signature element.** Each card has small L-shaped bracket marks in all 4 corners, creating a "targeting/HUD" aesthetic. These are about 6-8px per leg, 1px thick, and match the card's border color.

### Implementation: CSS Pseudo-Elements

Add `::before` and `::after` pseudo-elements to `.agent-card`. Each pseudo-element renders 2 of the 4 corners using `border-top` + `border-left` for top-left/bottom-right, and `border-top` + `border-right` for top-right/bottom-left.

```css
/* Registration corner brackets — Albert signature element */
.agent-card::before,
.agent-card::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  pointer-events: none;
  z-index: 1;
}

/* Top-left + Bottom-right corners (::before) */
.agent-card::before {
  top: 2px;
  left: 2px;
  border-top: 1px solid var(--border-cyan);
  border-left: 1px solid var(--border-cyan);
  /* Bottom-right corner via box-shadow trick */
  box-shadow:
    calc(100% - 4px + var(--card-w, 200px)) 0 0 0 transparent; /* not reliable */
}

/* Better approach: use 4 pseudo-elements via double-element trick */
```

**Recommended approach — use `::before` for top-left + bottom-right and `::after` for top-right + bottom-left:**

```css
.agent-card {
  position: relative; /* already set */
}

/* Top-left and bottom-right registration marks */
.agent-card::before {
  content: '';
  position: absolute;
  top: 3px; left: 3px;
  width: 7px; height: 7px;
  border-top: 1px solid var(--border-cyan);
  border-left: 1px solid var(--border-cyan);
  pointer-events: none;
  opacity: 0.6;
  transition: opacity 0.3s;
}

/* Top-right and bottom-left registration marks */
.agent-card::after {
  content: '';
  position: absolute;
  top: 3px; right: 3px;
  width: 7px; height: 7px;
  border-top: 1px solid var(--border-cyan);
  border-right: 1px solid var(--border-cyan);
  pointer-events: none;
  opacity: 0.6;
  transition: opacity 0.3s;
}
```

**But that only gives 2 of 4 corners.** For all 4 corners, use an inner wrapper or SVG background. The cleanest CSS-only approach uses `background-image` with multiple linear-gradients:

```css
.agent-card {
  position: relative;
}

.agent-card::before {
  content: '';
  position: absolute;
  inset: 3px;
  pointer-events: none;
  z-index: 0;
  /* 4 corner brackets via background gradients */
  background-image:
    /* top-left L */
    linear-gradient(to right, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to bottom, var(--corner-color) 7px, transparent 7px),
    /* top-right L */
    linear-gradient(to left, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to bottom, var(--corner-color) 7px, transparent 7px),
    /* bottom-left L */
    linear-gradient(to right, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to top, var(--corner-color) 7px, transparent 7px),
    /* bottom-right L */
    linear-gradient(to left, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to top, var(--corner-color) 7px, transparent 7px);
  background-position:
    0 0,          /* TL horizontal */
    0 0,          /* TL vertical */
    100% 0,       /* TR horizontal */
    100% 0,       /* TR vertical */
    0 100%,       /* BL horizontal */
    0 100%,       /* BL vertical */
    100% 100%,    /* BR horizontal */
    100% 100%;    /* BR vertical */
  background-size: 7px 1px, 1px 7px, 7px 1px, 1px 7px, 7px 1px, 1px 7px, 7px 1px, 1px 7px;
  background-repeat: no-repeat;
  opacity: 0.5;
  transition: opacity 0.3s;
}

.agent-card:hover::before {
  opacity: 1;
}

.agent-card.active::before {
  --corner-color: var(--gold);
  opacity: 0.8;
}
.agent-card.recent::before {
  --corner-color: var(--purple);
  opacity: 0.8;
}
.agent-card.stale::before {
  --corner-color: var(--orange);
  opacity: 0.8;
}
.agent-card.idle::before {
  --corner-color: var(--text-faint);
  opacity: 0.3;
}
```

**Note:** The `--corner-color` custom property defaults to `var(--border-cyan)` — set it on the base `.agent-card::before`:

```css
.agent-card::before {
  --corner-color: var(--border-cyan);
  /* ... rest from above */
}
```

### Alternative: SVG approach (simpler, more reliable)

If the gradient approach is too brittle, embed an SVG with 4 L-brackets as a data URI background:

```css
.agent-card::before {
  content: '';
  position: absolute;
  inset: 3px;
  pointer-events: none;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'%3E%3Cpath d='M0,0 L8,0 M0,0 L0,8' stroke='%2300d4e4' stroke-width='1' fill='none' opacity='0.5'/%3E%3Cpath d='M100%25,0 L calc(100%25-8),0 M100%25,0 L100%25,8' stroke='%2300d4e4' stroke-width='1' fill='none' opacity='0.5'/%3E%3C/svg%3E") no-repeat;
}
```

**Recommendation:** Use the **background-gradient approach** (first method). It's pure CSS, no SVG encoding headaches, and performs well. Test with `opacity: 0.5` default, `1.0` on hover.

---

## 3. Central Radial Gradient Behind Icons

Albert has a subtle radial glow emanating from behind each card's circular icon. This is currently missing entirely.

### Implementation

Add a radial gradient to the `.agent-icon` container using a `::before` pseudo-element or a `background` property:

```css
.agent-icon {
  width: 36px; height: 36px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--border); flex-shrink: 0;
  transition: border-color 0.3s, box-shadow 0.3s;
  position: relative; /* needed for pseudo-element */
}

/* Central radial gradient behind icon — Albert signature */
.agent-icon::before {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(0, 212, 228, 0.12) 0%, transparent 70%);
  pointer-events: none;
  z-index: -1;
}

/* Status-specific glow colors */
.agent-card.active .agent-icon::before {
  background: radial-gradient(circle, rgba(232, 184, 76, 0.15) 0%, transparent 70%);
}
.agent-card.recent .agent-icon::before {
  background: radial-gradient(circle, rgba(167, 139, 250, 0.12) 0%, transparent 70%);
}
.agent-card.stale .agent-icon::before {
  background: radial-gradient(circle, rgba(249, 115, 22, 0.12) 0%, transparent 70%);
}
```

---

## 4. Background Grid — Subtle Adjustment

**Current:** Grid at `rgba(0, 212, 255, 0.03)` with `40px` squares.
**Albert:** Grid at `rgba(0, 212, 228, 0.04)` with `~30-40px` squares.

Close enough. Minor tweak:

```css
body {
  background-image:
    linear-gradient(rgba(0, 212, 228, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 212, 228, 0.035) 1px, transparent 1px);
  background-size: 36px 36px;
}
```

---

## 5. Card Styling Differences

### Current vs Albert

| Property | Current | Albert | Fix |
|---|---|---|---|
| `background` | `#0f1d33` (opaque) | `rgba(15, 30, 53, 0.5)` (translucent) | Use rgba |
| `border-radius` | `0` | `0` | ✅ Already correct |
| `border` | `1px solid var(--border)` | `1px solid #1e3a5f` | ✅ Already matches (after `--border` update) |
| `padding` | `12px` | `16-20px` | **Increase to `14px`** (compromise for compact grid) |
| Shadow | none | none | ✅ Correct |
| Corner brackets | ❌ missing | ✅ present | **Add (see §2)** |

### Updated `.agent-card`:

```css
.agent-card {
  background: var(--bg-card); /* now translucent */
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 14px;
  display: flex; flex-direction: column;
  gap: 10px; cursor: default;
  transition: background 0.15s, border-color 0.3s;
  position: relative;
}
```

---

## 6. Typography Adjustments

| Element | Current | Albert | Fix |
|---|---|---|---|
| `.agent-name` color | `var(--text)` = `#c8d6e5` | `#e8f4f8` (brighter) | **Already fixed via `--text` update** |
| `.agent-name` weight | `600` | `600-700` | ✅ OK |
| `.agent-name` letter-spacing | `0.5px` | `0.05em` | Close enough — use `0.05em` |
| `.agent-model` color | `var(--text-faint)` | `#5a7a9a` | **Already fixed via `--text-faint` update** |
| `.category-label` | `var(--cyan)` | `#00d4e4` | **Already fixed via `--cyan` update** |
| `body` font-size | `12px` | `12px` | ✅ |
| Section headers | `letter-spacing: 2px` | `letter-spacing: 0.15em` | Change to `0.15em` (≈2.4px at 11px, close enough — keep `2px` or use `0.15em`) |

**No major typography changes needed** — the font stack and sizes are already aligned. The main fix is the brighter `--text` color.

---

## 7. Task Card Sidebar Panels

Apply the same translucent background and consider adding corner brackets to sidebar task cards:

```css
.task-card {
  background: var(--bg-card); /* now translucent */
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 10px;
  margin-bottom: 6px;
  position: relative;
}

/* Optional: corner brackets on task cards too */
.task-card::before {
  content: '';
  position: absolute;
  inset: 2px;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--border-cyan) 5px, transparent 5px),
    linear-gradient(to bottom, var(--border-cyan) 5px, transparent 5px),
    linear-gradient(to left, var(--border-cyan) 5px, transparent 5px),
    linear-gradient(to top, var(--border-cyan) 5px, transparent 5px);
  background-position: 0 0, 0 0, 100% 100%, 100% 100%;
  background-size: 5px 1px, 1px 5px, 5px 1px, 1px 5px;
  background-repeat: no-repeat;
  opacity: 0.3;
}
```

---

## 8. Status Pill Adjustments

Albert's pills are slightly different in color. Update the pill backgrounds to match new palette:

```css
.agent-card.active .agent-status-pill {
  background: rgba(232, 184, 76, 0.12);
  color: var(--gold); /* now #e8b84c */
}
.agent-card.recent .agent-status-pill {
  background: rgba(167, 139, 250, 0.1);
  color: var(--purple); /* now #a78bfa */
}
.agent-card.stale .agent-status-pill {
  background: rgba(249, 115, 22, 0.1);
  color: var(--orange); /* now #f97316 */
}
```

---

## 9. Header Adjustments

The header should match the darker panel background:

```css
.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px;
  background: var(--bg-panel); /* now #080f1c — darker */
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-left h1 {
  font-size: 13px; font-weight: 600;
  letter-spacing: 2px; text-transform: uppercase;
  color: var(--cyan); /* now #00d4e4 — more teal */
}
```

---

## 10. Sidebar Nav Adjustments

```css
.sidebar-nav {
  width: 52px;
  background: var(--bg-sidebar); /* now #060d18 — matches main */
  border-right: 1px solid var(--border);
  /* rest unchanged */
}
```

---

## Prioritized Implementation List

### P0 — Critical (Biggest Visual Impact)
1. **Darken `--bg` to `#060d18`** and `--bg-panel` to `#080f1c` — immediately shifts the mood
2. **Add corner registration brackets** to `.agent-card` via `::before` pseudo-element with background gradients
3. **Make card backgrounds translucent** — `rgba(15, 30, 53, 0.5)` instead of opaque
4. **Brighten `--text` to `#e8f4f8`** — text pops more against darker bg

### P1 — High (Noticeable Improvement)
5. **Add radial gradient behind agent icons** — `.agent-icon::before` with `radial-gradient(circle, rgba(0,212,228,0.12), transparent 70%)`
6. **Update accent colors** — gold to `#e8b84c`, purple to `#a78bfa`, orange to `#f97316`, cyan to `#00d4e4`
7. **Increase card padding** from `12px` to `14px`
8. **Update status pill colors** to match new accent palette

### P2 — Medium (Polish)
9. **Fine-tune grid lines** — `0.035` opacity, `36px` squares, `#00d4e4` tint
10. **Add corner brackets to `.task-card`** in sidebar (smaller, subtler)
11. **Adjust `--text-dim` to `#5a7a9a`** and `--text-faint` to `#3a5a7a`
12. **Update `--border` to `#1e3a5f`** for slightly more blue tone

### P3 — Low (Nitpicks)
13. **Letter-spacing on `.agent-name`** — switch from `0.5px` to `0.05em`
14. **Sidebar bg** — match `--bg` exactly (`#060d18`)
15. **Add hover state to corner brackets** — opacity `0.5` → `1.0` on card hover

---

## Complete CSS Diff (Copy-Paste Ready)

Replace the entire `:root` block and add new rules:

```css
/* ═══ UPDATED :root ═══ */
:root {
  --bg: #060d18;
  --bg-panel: #080f1c;
  --bg-card: rgba(15, 30, 53, 0.5);
  --bg-card-hover: rgba(20, 38, 65, 0.6);
  --bg-sidebar: #060d18;
  --border: #1e3a5f;
  --border-cyan: #00d4e4;
  --text: #e8f4f8;
  --text-dim: #5a7a9a;
  --text-faint: #3a5a7a;
  --gold: #e8b84c;
  --gold-glow: rgba(232,184,76,0.15);
  --purple: #a78bfa;
  --purple-glow: rgba(167,139,250,0.1);
  --teal: #2dd4bf;
  --teal-glow: rgba(45,212,191,0.08);
  --orange: #f97316;
  --orange-glow: rgba(249,115,22,0.12);
  --cyan: #00d4e4;
  --amber: #e8b84c;
  --red: #ef4444;
  --green: #22c55e;
  --font: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'IBM Plex Mono', 'Consolas', monospace;
}

/* ═══ UPDATED body grid ═══ */
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  background-image:
    linear-gradient(rgba(0, 212, 228, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 212, 228, 0.035) 1px, transparent 1px);
  background-size: 36px 36px;
}

/* ═══ UPDATED agent-card ═══ */
.agent-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 14px;
  display: flex; flex-direction: column;
  gap: 10px; cursor: default;
  transition: background 0.15s, border-color 0.3s;
  position: relative;
}

/* ═══ NEW: Registration corner brackets ═══ */
.agent-card::before {
  content: '';
  position: absolute;
  inset: 3px;
  pointer-events: none;
  z-index: 0;
  --corner-color: var(--border-cyan);
  background-image:
    linear-gradient(to right, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to bottom, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to left, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to bottom, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to right, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to top, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to left, var(--corner-color) 7px, transparent 7px),
    linear-gradient(to top, var(--corner-color) 7px, transparent 7px);
  background-position:
    0 0, 0 0,         /* TL */
    100% 0, 100% 0,   /* TR */
    0 100%, 0 100%,   /* BL */
    100% 100%, 100% 100%; /* BR */
  background-size: 7px 1px, 1px 7px;
  background-repeat: no-repeat;
  opacity: 0.5;
  transition: opacity 0.3s;
}

.agent-card:hover::before { opacity: 1; }
.agent-card.active::before { --corner-color: var(--gold); opacity: 0.8; }
.agent-card.recent::before { --corner-color: var(--purple); opacity: 0.8; }
.agent-card.stale::before { --corner-color: var(--orange); opacity: 0.8; }
.agent-card.idle::before { --corner-color: var(--text-faint); opacity: 0.3; }

/* ═══ NEW: Radial gradient behind icons ═══ */
.agent-icon {
  position: relative;
}

.agent-icon::before {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(0, 212, 228, 0.12) 0%, transparent 70%);
  pointer-events: none;
  z-index: -1;
}

.agent-card.active .agent-icon::before {
  background: radial-gradient(circle, rgba(232, 184, 76, 0.15) 0%, transparent 70%);
}
.agent-card.recent .agent-icon::before {
  background: radial-gradient(circle, rgba(167, 139, 250, 0.12) 0%, transparent 70%);
}
.agent-card.stale .agent-icon::before {
  background: radial-gradient(circle, rgba(249, 115, 22, 0.12) 0%, transparent 70%);
}

/* ═══ UPDATED status pills (use new palette) ═══ */
.agent-card.active .agent-status-pill {
  background: rgba(232,184,76,0.12); color: var(--gold);
}
.agent-card.recent .agent-status-pill {
  background: rgba(167,139,250,0.1); color: var(--purple);
}
.agent-card.stale .agent-status-pill {
  background: rgba(249,115,22,0.1); color: var(--orange);
}

/* ═══ UPDATED task-card ═══ */
.task-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 10px;
  margin-bottom: 6px;
  position: relative;
}

/* Optional corner brackets on task cards */
.task-card::before {
  content: '';
  position: absolute;
  inset: 2px;
  pointer-events: none;
  --tc-corner: var(--border-cyan);
  background-image:
    linear-gradient(to right, var(--tc-corner) 5px, transparent 5px),
    linear-gradient(to bottom, var(--tc-corner) 5px, transparent 5px),
    linear-gradient(to left, var(--tc-corner) 5px, transparent 5px),
    linear-gradient(to top, var(--tc-corner) 5px, transparent 5px);
  background-position: 0 0, 0 0, 100% 100%, 100% 100%;
  background-size: 5px 1px, 1px 5px;
  background-repeat: no-repeat;
  opacity: 0.3;
}

.task-card.active::before { --tc-corner: var(--gold); opacity: 0.6; }
.task-card.recent::before { --tc-corner: var(--purple); opacity: 0.6; }
```

---

## Summary of Changes

| Change | Impact | Effort |
|---|---|---|
| Darker background (`#060d18`) | 🔴 Critical | 1 line |
| Corner brackets on cards | 🔴 Critical | ~25 lines CSS |
| Translucent card bg | 🔴 Critical | 1 line |
| Brighter text (`#e8f4f8`) | 🔴 Critical | 1 line |
| Radial icon glow | 🟡 High | ~15 lines CSS |
| Accent color shifts | 🟡 High | ~6 lines |
| Card padding increase | 🟡 Medium | 1 line |
| Task card corner brackets | 🟢 Polish | ~15 lines |
| Grid line adjustment | 🟢 Polish | 2 lines |

**Total effort:** ~70 lines of CSS changes, all in the inline `<style>` block of `index.html`.
**Expected result:** Visually transforms from "close to Albert" to "indistinguishable from Albert."
