# Changelog

All notable changes to Guarded Browser. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/).

No release has been tagged in git. Each date below is a commit date from `git log`: the day
`package.json` took that version, and for 0.2.2 also the last day of work committed while the
version stayed 0.2.2. There was never a 0.2.1. Commit hashes are given so each entry can be
checked.

## [0.2.2] - 2026-10-03

`package.json` moved to 0.2.2 in `40948f4` (2026-10-02). Everything below was committed at that
version, through `0d65f62` (2026-10-03).

### Added
- **Mail client** (`40948f4`, tickets 34-37d): IMAP over implicit TLS with sync, a per-profile
  sqlite message store with FTS5 search, passphrase-encrypted account secrets, import of accounts
  from a himalaya config (`password.cmd` is reported, never run), and mail as a panel inside the
  browser window (rail button, `Ctrl+Shift+M`).
- Mail accounts listed in the left column, above the folder tree (`fcb7e38`).
- **HTML mail view** (`58bca90`, `47812b6`): HTML messages render in a locked-down native view
  (JavaScript off, own in-memory session, sanitized document with a CSP, navigation prevented).
- **Remote content opt-in** (`58bca90`): remote images stay blocked until *Load External Content*,
  for that display only; refused during an agent task.
- **Compose and send** (`f1a8082`, ticket 38): compose, reply, reply all, forward, quick reply,
  drafts, a local outbox with retry, SMTP over implicit TLS (465) or strict STARTTLS (587), Sent
  copy by APPEND.
- **Attachments** (`6f5d45d`, ticket 41): BODYSTRUCTURE listing, download only on a click, Open
  behind a confirmation, attach and forward on send, inline `cid:` images.
- **Injection X-ray** (`717da2d`): per-tab view of hidden text, guard verdicts, third-party hosts
  and off-site forms.
- **AI chat panel** (`402ad1f`): a quarantined, tool-less `chat` model role about the current tab,
  fed a semantic markdown snapshot that leaves out hidden text.
- **MCP server and phone approvals** (`0373059`): another local AI program (Claude Code, Hermes) can
  hand the browser a browsing task over MCP; confirmations can also be answered from Telegram.
- **Inbox triage** (`b685783`): a quarantined `triage` model role sees one message's typed, capped,
  guard-screened fields at a time; every action on the results needs approval of the exact list.
- **Recipes and watchers** (`6946a6c`, `7ef449b`): save a finished task as a recipe and replay it
  with no model; read-only scheduled watchers in throwaway sessions, with an optional external
  CDP runner.

### Changed
- The confirmation layer shows exactly what it approves; task secrets in a navigated URL are caught
  plain, URL-encoded, base64 and hex; confirmation ids are collision-proof; the post-task gate
  lifts when the user's navigation commits and keeps a 30 s tombstone for unload beacons
  (`dfabc3f`).
- One atomic JSON store primitive; unreadable store files are quarantined instead of overwritten
  (`ac41087`).
- One IPC channel registry in `src/shared/ipc.ts` (`22fe0a1`); the profile runtime is split into
  `src/main/runtime/` modules (`f6a741b`, `5258848`, `08e7351`).
- `@types/node` pinned to 24.19 to match the Node embedded in Electron 44 (`6e60a9f`).

### Fixed
- IMAP wire protocol (literal byte counting, unterminated literals), the task gate enforced on every
  mail action, reconnect after drops (`2d7a4ea`).
- RFC 2047 subjects and sender names decoded from the IMAP ENVELOPE; stored rows repaired
  (`e629459`).
- Mail panel: no page view drawn over it (`e9fb712`); a link click closes the panel so the new tab
  is in view (`b7c4bb8`); list rows truncate long text instead of clipping it (`3bc3a37`).
- Side panels: the page starts at the panel's edge instead of 220 px past it (`0d65f62`).

## [0.2.0] - 2026-10-02

Version set in `a6a2d55`.

### Added
- Vivaldi-parity browsing features: reopen closed tabs, session restore, zoom, find in page, print,
  page context menu, downloads panel, search-engine setting, keyboard map, start page, quick
  commands, remappable keybindings, mouse gestures, left icon rail with panels, web panels,
  workspaces, saved sessions, tab hibernation, reader mode, translate (off by default), capture,
  status bar, tab strip placement, private windows (ephemeral profiles), portable profile bundle.
- Back-end only, with no working UI path as of `0d65f62`: tab reordering, creating tab stacks, page
  actions, and an unpacked-extensions list (the loader is never called).
- Per-tab security state record and the post-task gate book (`src/main/tab-guard.ts`).

## [0.1.0] - 2026-09-28

First version (`47718f0` through `8b286c0`).

### Added
- The guarded agent: privileged planner that never reads page bodies, quarantined tool-less
  reader with string handles, taint registry and policy engine, action judge that can only
  escalate, human confirmation with default deny, append-only audit log.
- Egress filtering: per-profile forward proxy with a task allowlist, webRequest gates for
  state-changing requests and tracked values, WebRTC UDP disabled, staged task downloads.
- Host reputation feeds (keyless, 24 h refresh) with an interstitial the agent cannot pass.
- Prompt-injection guard model (`protectai/deberta-v3-base-prompt-injection-v2`), pinned revision
  and sha256.
- Profiles (one session partition, app-state directory and proxy each), split view, themes with
  enforced readability, history and bookmarks with Netscape import and export.
- Packaging: electron-builder output wrapped in an RPM (`/opt/guarded-browser`, desktop entry,
  `chrome-sandbox` 4755), AppImage, `verify:package`; Apache-2.0 license.
