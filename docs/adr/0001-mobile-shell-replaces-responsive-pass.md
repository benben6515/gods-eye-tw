# 0001 — Mobile Shell replaces the ≤720px responsive pass

Status: accepted

The existing mobile support (~36 media-query blocks in 13 files plus `responsive.css`) shrinks Desktop Chrome into the phone: the left panel stack takes the top half-screen, the right rail the bottom half, leaving almost no map. Patching cannot fix a structural problem, so the ≤720px experience is rebuilt as the Mobile Shell (bottom-sheet dock + control drawer + player sheet) and the old desktop-shrunk mobile rules are removed. Desktop Chrome is untouched; the breakpoint stays at 720px to match the existing `layoutMode='mobile'` JS detection.

## Consequences

- Two layout systems intentionally diverge: mobile CSS lives with the shell, not as `@media` shrinks of desktop blocks.
- Cockpit keeps its own ≤760px pass this round — it is explicitly out of scope.
- Future components must ship with a Mobile Shell placement decision, not a default desktop-shrink.
