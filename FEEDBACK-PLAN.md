# Feedback Widget Plan — Dispatch HUD Orbit View

**Goal:** Add a floating feedback button (bottom-right) that opens a panel with a text input. Submissions are saved to `feedback.json`.

---

## Increment 1 — Scaffolding & Markup
- Add a floating `<button>` fixed to bottom-right of the orbit view container.
- Add a hidden panel `<div>` with a `<textarea>` and submit/close buttons.
- Wire click on the button to toggle panel visibility (CSS class toggle).
- Minimal CSS: fixed positioning, z-index above orbit canvas, semi-transparent backdrop.

## Increment 2 — Feedback Submission Logic
- On submit click, read textarea value.
- Validate non-empty (trim).
- Append `{ timestamp, text }` entry to the feedback list.
- Write the full list to `/home/node/.openclaw/workspace/dispatch-hud/feedback.json` (create file if missing).
- Clear textarea, close panel, show brief "Submitted ✓" confirmation.

## Increment 3 — Persistence & File I/O
- On panel open, read existing `feedback.json` (if present) to show a count of prior submissions.
- Handle file write errors gracefully (log + user-facing error note).
- Ensure JSON is pretty-printed for readability.

## Increment 4 — Polish & Styling
- Add subtle hover/focus states on the button and panel.
- Animate panel open/close (slide + fade).
- Make panel responsive (max-width, scrollable textarea on small viewports).
- Ensure button doesn't overlap existing HUD controls — adjust if needed.

## Increment 5 — Review & Integration Test
- Open orbit view, click feedback button, type feedback, submit.
- Verify `feedback.json` is created/updated correctly.
- Reopen panel — confirm prior submission count reflects.
- Check for conflicts with existing HUD interactions (pointer events, z-index stacking).

---

**Approach notes:**
- No external libraries — plain DOM + existing HUD style conventions.
- Feedback file path is absolute and fixed; no user configuration needed.
- The widget is self-contained and can be added as a single include/module to the orbit view.
