# Target mail UI — measured from the user's Vivaldi Mail screenshot

> **Status (2026-10-04).** Mail shipped (tickets 34-41, commits `40948f4` to `3bc3a37`). The
> measurements below are kept as measured. Where the shipped mail UI differs from them:
> - Mail is a **panel in the browser window**, not a separate window: it fills the whole width
>   beside the rail (at least 720 px; `MAIL_MIN` in `src/renderer/library.ts`), opened from the
>   rail's envelope or `Ctrl+Shift+M` (ticket 37c).
> - The tree (206 px) and list (242 px) columns use these measurements (`#m-left`, `#m-list` in
>   `src/renderer/styles.css`). The tree column is not account-free: **accounts are listed at the
>   top of the left column, above the folder tree** (`fcb7e38`).
> - **HTML is rendered**, in a locked-down native view (`src/main/mail/html-view.ts`): JavaScript
>   off, sandboxed, its own in-memory `mailview-<profileId>` session, a sanitized document
>   (`src/core/mail/html.ts`) whose CSP allows only `data:` images, every request cancelled, and
>   navigation prevented (an http(s) link opens a normal tab). *Load External Content* allows
>   remote images for that display only and is refused during an agent task.
> - The rail discrepancy recorded below is resolved: `RAIL_WIDTH` is now 51
>   (`src/renderer/panels.ts`), as measured.
> - Items 2 and 3 of "Decisions this spec implies for ticket 37" are superseded (marked there).

**Source:** `~/Pictures/Screenshots/261002_11h11m10s_screenshot.png` (3840x2400 PNG, native).
**Display:** eDP-1 3840x2400 @120 Hz, COSMIC scale **187%** (`cosmic-randr list`) → logical viewport
**2053x1283**; screenshot px = physical px = logical x 1.87.

This is the `docs/target-ui.md` process applied to mail: scale factor first, boundaries by pixel scan,
a ruler overlay read back with vision, and every band mapped onto the code's existing constants. The
mail window (ticket 37) builds against these numbers, not against an eyeballed render.

Method note: vertical boundaries below are **measured numerically** (fraction-of-rows above a colour
threshold over a 2000-px span, so they are column separators and not text). Horizontal bands come from
the ruler overlay (`ruler-top2.png`: lines every 10 logical px, labels every 20) and are marked
**approximate** where the automation's row detection and the ruler disagreed. One band is recorded as
unresolved rather than guessed.

---

## Columns (measured, native 3840 px, logical px at 1.87)

| column | left | right | width | evidence |
|---|---|---|---|---|
| icon rail | 0 | **50.8** | 50.8 | background changes `(58,57,64)` → `(54,55,56)` at physical x=95, frac 1.00 over y 300–2200 |
| folder tree (Mail / All Messages / Custom Folders / …) | 50.8 | **256.7** | 205.9 | divider band 256.7–270.6, bright separator line at 257.2–267.9 `(155,159,168)` |
| message list | 270.6 | **512.3** | 241.7 | bright separator at 515.5–526.2 `(175,176,185)` |
| reading pane | 529.4 | 2053 | 1523 | message content (white body `(236,238,243)` at y=535 logical) begins at 529.4 |

The panel column (tree + list) therefore spans **50.8 → 512.3** and the reading pane takes the
remainder. The tree/list columns start **at the rail's right edge**, not behind it.

## Rows (approximate; ruler-read)

| band | top | bottom | height | content |
|---|---|---|---|---|
| browser toolbar | ~96 | ~130 | 34 | ← → ↻ ✎ ↩, then the **Mail Search** field, its filter + layout controls, then the message-group controls |
| mail panel header | ~133 | ~172 | 39 | **Mail** title + close ✕ (this row spans the panel column only) |
| panel toolbar | ~174 | ~205 | 31 | ↻ ⚑ ✎ **Comp…** ⋯ |
| result/filter row | ~205 | ~232 | 27 | `20 messages` · `View Filters ⚙` |
| column header | ~232 | ~268 | 36 | `Sort by Date (Threaded)` + a `⌄` control |
| first message row | ~272 | — | **68** | row pitch from autocorrelation of the list column's text profile (peak lag 127–131 physical = 68–70 logical) |

Reading-pane header bands: `From` row and `To` row sit in the same ~133–205 span, right of the list.
Below them: a banner row (`This message was prevented from loading external content.` with a
`Load External Content` action at the right), then the message body.

Composer + status (bottom): reply textarea starting ~1027 logical (`Write a quick reply here`), a
`Send` button with a paper-plane glyph at ~1163–1188, `Include Quoted Text` checkbox right-aligned in
the same strip, then the status bar ~1195–1250 containing (right group) open-external, capture, tiling
and popout icons, `Reset`, the zoom slider, `100 %`, and the clock `11:11 AM`.

## Unresolved band

**The exact top of the "All Messages" section** could not be settled between two readings: the ruler
puts the row at ~205–235 logical, the automated uniform-row scan puts a boundary at ~202 and another at
~237 (i.e. the same place, ±3). **Do not treat this as measured.** Ticket 37 renders the tree with a
section header pitch and the user's screenshot is the tiebreaker on screen.

## Labels and controls (verbatim, for the UI strings)

Panel sections, in order: `Mail` · `All Messages` · `Unread` · `Received` · `Sent` · `Drafts` ·
`Outbox` · `Spam` · `Trash` · `Archive` · `Custom Folders` · `Mailing Lists` · `Filters` · `Flags` ·
`Labels` · `Feeds`.

Left of the tree there is **no account list** — this profile has no account section; `Trash` is
duplicated across `All Messages` and `Feeds`. Counters are two numbers per folder (`4 20` on Unread and
Received — a new-mail count and a total), shown right-aligned in a light chip.

Message-list controls: `20 messages`, `View Filters`, `Sort by Date (Threaded)`.

Message view toolbar (the group right of the search field): reply · reply-all · forward · flag ⌄ ·
label ⌄ · mark-unread/archive · move ⌄ · delete ⌄.

Selected message row: a **blue** highlight band across the row's full width.

Left column, bottom of the window (the *browser* rail, not the panel): `⚙` (settings), an
`⏸`-looking pause/tiles icon, cloud, envelope with a blue badge `4` (mail, unread count), calendar.
This confirms the mail entry point the parity plan already specified: a **rail button with an unread
badge**, and the settings gear stays bottom-pinned in the rail.

## Discrepancy against the shipped code (report before changing)

*Resolved 2026-10-02: the user approved the correction and `RAIL_WIDTH` is 51.*

`src/renderer/panels.ts` declares `RAIL_WIDTH = 27` ("icon rail 51 physical / 27 logical px wide").
Both the browser screenshot used for `docs/target-ui.md` and today's mail screenshot measure the rail's
right edge at **physical x = 95 → 50.8 logical**, with the rail icons centred near logical 30. So the
shipped rail is about **half the measured width**, and `PANEL_WIDTH = 220` is correct only for the
browser's panel column (the mail tree column measures 206).

This is recorded, not acted on: correcting the rail changes chrome geometry the user has rejected
guessed changes to before. It needs their call.

## Decisions this spec implies for ticket 37

1. Mail UI = tree column (206) + list column (242) + reading pane, matching the measured widths, with
   the panel column starting at the rail's right edge.
2. *Superseded by ticket 37c (2026-10-02): mail is a full-width panel in the browser window, not a
   separate window.* The mail window is a **separate BrowserWindow** (the plan's rule 4: a `PanelId` would put message
   text inside the shared panel column by construction). The rail entry point and the
   `Ctrl+Shift+M` chord open it.
3. *Superseded (2026-10-02, `58bca90`): HTML is rendered in a locked-down view, and remote images
   load only after Load External Content, for that display.* Attachment/remote-content behaviour
   follows the store: HTML is never rendered, the banner says so,
   and `Load External Content` is the only action that would fetch — and it is refused during a task.
