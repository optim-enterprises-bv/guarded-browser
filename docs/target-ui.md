# Target UI measurements — Vivaldi parity

> **Status (2026-10-04).** The measurements below are unchanged. The "Deltas against the current
> app" table at the end describes the app as it was on 2026-09-30 and is superseded:
> - the left icon rail exists and is **51** logical px wide (`RAIL_WIDTH = 51`,
>   `src/renderer/panels.ts`; it first shipped as 27 and was corrected to the measurement on
>   2026-10-02);
> - the browser panel column is **220** (`PANEL_WIDTH` in `src/renderer/panels.ts`, `SIDE` in
>   `src/renderer/library.ts`); AI chat, Recipes and Watchers use a wider 400 px column (`CHAT`),
>   and Mail takes the whole width beside the rail (at least 720 px);
> - the status bar exists; it is **32** px tall, not the measured 19, on purpose ("32 keeps the hit
>   targets usable", `STATUS` in `src/renderer/library.ts`);
> - `PANEL_WIDTH = 440` in `src/main/tabs.ts` is the **right-hand agent panel**, a different panel
>   from the 220 px left column; the delta row "panel width 440 → 220" conflated the two.
>   `TOP_BAR = 84` there is now a minimum: the renderer reports the real top inset through
>   `chrome:insets` and `setInsets` keeps the larger value.

Source: `~/Pictures/Screenshots/260930_08h11m53s_screenshot.png`
(3840x2400). Measured 2026-09-30 by pixel scanning, not by eye.

## How these numbers were produced

- Tool used: `sharp` 0.35.5 (already in `node_modules`) via
  `~/.hermes/cache/scratch/measure-v{2..9}.mjs`. ImageMagick 7 was used only to
  produce annotated crops for reading.
- Method: per-row and per-column mean colour over chrome-only spans; band boundaries are
  colour change points, and each band was then confirmed against an annotated crop.
- **Scale factor: 1.87** (COSMIC is at 187% on `eDP-1` 3840x2400 per `cosmic-randr list`;
  logical viewport 2053x1283). Every "logical" column below is `physical / 1.87`.
- Evidence that 1.87 applies to Vivaldi's own chrome too: the measured panel column comes out
  at **271 logical px**, which matches Vivaldi's default sidebar width (~280), and the tool
  rows land on normal control sizes. The one band that does *not* fit is the tab strip — see
  the caveat below.
- `python3` and ImageMagick were both available on this host; `sharp` was chosen because it is
  already a project dependency and needs no install.

## Horizontal bands — top chrome

| band | physical y | logical y | content |
|---|---|---|---|
| OS top panel / window title row | 0..62 | 0..33 | COSMIC TopPanel: droplet + a window-title pill, tray icons right |
| tab strip row | ~66..100 | ~35..53 | numbered tabs `1`..`5`; the active tab (2) carries a close ✕ |
| toolbar row | 92..180 | 49..96 | left: workspace switcher + mail/feeds/translate icons; centre-right: address bar |
| toolbar icon row | 100..150 (x>2550) | 53..80 | action/extension icons; far right `−` `▢` `✕` window buttons |
| navigation row | 185..245 | 99..131 | back / forward / reload (left side); site-security chip (right side) |
| content top | ~248 | ~133 | page area begins |

**Caveat, recorded rather than guessed:** the tab strip and the OS title row are vertically
adjacent and both carry a page title / numbered tabs, so the exact split between "OS panel" and
"Vivaldi tab strip" cannot be resolved from pixels alone — the row may be shared (Vivaldi tab
strip drawn inside the title bar). Treat the tab strip height as **~34 physical / ~18 logical**
on the low end to **~62 physical / ~33 logical** on the high end, and settle it when the app's
own tab strip is built (ticket 21) by comparing against a Vivaldi window that is *not* maximised
under a panel.

## Horizontal bands — bottom chrome

| band | physical y | logical y | content |
|---|---|---|---|
| page bottom | 2274 | 1216 | page content ends |
| status bar | 2275..2311 | 1217..1236 | h = 36 physical / **19 logical** |
| separator inside the bar | 2291..2294 | 1225..1227 | 4px bright rule |
| window bottom | 2312 | 1236 | window ends; below is desktop + the COSMIC bottom panel (y 2354..2400) |
| screen height | 2400 | 1283 | |

Status bar content, right-aligned, left to right: **4 icon buttons** (open/popout, capture,
tiling toggle, …), the literal label **`Reset`**, a **slider**, the readout **`100 %`**, then a
**clock** (`08:11 AM`). The left side of the bar is empty.

## Vertical boundaries

| band | physical x | logical x | width (logical) |
|---|---|---|---|
| left icon rail | 0..95 | 0..51 | **51** (icons centred at x ≈ 52 physical / 28 logical) |
| panel column | 95..507 | 51..271 | **220** |
| page | 507..3818 | 271..2042 | 1771 |
| window right edge | 3818..3820 | 2042..2043 | border |
| screen width | 3840 | 2053 | |

The rail and the panel share one background and are separated only by a faint tint change
(~rgb(53,52,58) vs ~rgb(57,57,59)); the panel's right edge is a hard break to the page's
rgb(15,19,28).

## Left rail inventory

- 18 icon runs at x 19..94, glyphs ≈ 34 physical / **18 logical** tall, centres ≈ 52 physical.
- First icon at y ≈ 112 physical (60 logical); pitch between icon centres ≈ **70 physical /
  37 logical**.
- A **divider** rule sits above the last group.
- A detached **2-icon group** at y 2246..2294 (1201..1227 logical) directly above the status
  bar — this is the bottom-pinned group (settings/tiling), not part of the scrolling list.

## Toolbar right group

Left to right: bookmark ribbon, grid layout, **site-security chip** (shield + padlock +
`www.optim…`), `VPN`, then the profile avatar. Window buttons (`−` `▢` `✕`) are at the far
right of the toolbar icon row, not stacked separately.

## Deltas against the current app

Current constants: `TOP_BAR = 84` and `PANEL_WIDTH = 440` in `src/main/tabs.ts:10-11`;
`setInsets(top, left)` clamps with `Math.max(TOP_BAR, top)` / `Math.max(0, left)`.

| quantity | app today | target | action |
|---|---|---|---|
| top chrome | 84 (one row) | content starts at ~131 logical across **3 stacked rows** (tab strip + toolbar + nav) | `TOP_BAR` must become a per-row sum; the single 84px constant cannot express the target |
| panel width | 440 | **220** | `PANEL_WIDTH` ≈ 220 (app's is ~2x too wide); make it resizable with a ~240 min |
| icon rail | does not exist | **51** wide, 18 items, pitch 37 | new `RAIL_WIDTH` constant |
| status bar | does not exist | **19** tall | new `STATUS_BAR` constant; must be added to the bottom inset |
| page left edge | 440 | 271 | follows from rail + panel |

The page's left edge is the sum of rail + panel, so `setInsets` needs a second left component
(rail) rather than folding the two into one number — otherwise the rail cannot be toggled
independently of the panel.
