# Guarded Browser — Mail program (closing the Vivaldi Mail gap)

**Decision this implements:** the Vivaldi parity plan declared Mail out of scope
(`2026-09-30_080607-vivaldi-parity.md`, "Explicitly out of scope": *"Mail, calendar, feeds,
notes, tasks … reimplementing a mail client inside a browser is weeks of work for no gain"*).
The user has overridden that for **Mail** specifically. Calendar, tasks and notes stay out of
scope; feeds are revisited as optional (42).

**Why the override is defensible here, when it was not in the original plan:** the original
objection was "no gain" — the user already runs James. That reasoning was about *their* workflow,
not the product. As a parity claim ("does this browser do what Vivaldi does") Mail is a real gap,
and the product's whole premise is that the *agent* is hardened; mail is the single highest-value
thing a hardened browser can hold, precisely because it is the canonical lethal-trifecta payload.
So this is a capability we build and then **architecturally deny to the agent**.

---

## Verified ground truth (this box, 2026-10-02)

Run before trusting anything below. All commands run in `~/guarded-browser`.

| gate | command | result today |
|---|---|---|
| typecheck | `npm run typecheck` | clean (exit 0) |
| unit | `npx vitest run --reporter=json` | **460/460 pass, 24 files** (282/19 before tickets 34-36b) |
| e2e | `node scripts/run-e2e.mjs` | **125 passed, 0 failed, 5.3 min, EXIT=0** — run on the pre-mail tree; the mail modules are not imported by `main.ts`, so the app binary is unchanged. Re-run when ticket 37 wires mail into the app. |
| version | `package.json` | 0.2.2 at the time of writing (0.2.0 when the plan was written) |
| e2e (final, ticket 37) | `node scripts/run-e2e.mjs` | **131 passed, 0 failed, 5.3 min, EXIT=0** (125 before + 6 mail specs) |
| unit (final, ticket 37) | `npx vitest run --reporter=json` | **494/494 pass, 25 files** |

**Mail tickets built so far:** 34 (store), 35a/35b (secrets, accounts/OAuth), 36 (MIME + IMAP protocol
+ sync engine), 36b (the TLS socket factory). New files: `src/core/mail/{store,mime,imap}.ts`,
`src/main/mail/{secrets,accounts,sync,socket}.ts`,
`test/unit/mail-{store,accounts,imap,sync,socket}.test.ts`, `test/helpers/fake-imap.ts`. Nothing imports
them from `main.ts` yet — that is ticket 37.

**Absence inventory by vocabulary grep** (four token kinds; count = hits in `src/` + `test/`):

| capability | feature noun | API symbol | keybinding | UI control | verdict |
|---|---|---|---|---|---|
| mail account / client | `mail` 64 hits — **all** of them `email`-as-taint-class, `email` input type, "test the mail" prose | `imap` 0, `smtp` 0, `pop3` 0, `jmap` 0, `mailbox` 0 | 0 | 0 | **absent** |
| contacts / address book | `contact` 17 (test fixtures: form fields) | 0 | 0 | 0 | absent |
| calendar / tasks | `calendar` 0 | 0 | 0 | 0 | absent |
| feeds (RSS/Atom reader) | `feed` 202 — **all** reputation threat-feed machinery (`core/reputation.ts`, `main/feed-worker.ts`) | — | 0 | 0 | **present but a different thing** (threat feeds ≠ a feed reader) |
| OAuth (for a mail account) | `oauth` 0 | 0 | 0 | 0 | absent |

`Mail` is therefore a genuinely absent *class*, not a missing feature name — the cheap test the
parity skill demands. Nothing in the tree has to be un-built.

**What already meets or beats Vivaldi, and must not be rebuilt or regressed:**

- **A real message store with zod validation + atomic 0600 JSON writes** (`core/history.ts`,
  `core/bookmarks.ts`) — the pattern the mail store follows (sqlite instead of JSON, because mail
  is a corpus: Vivaldi's own marketing names the local indexed database as the bedrock).
- **The strongest available answer to "what does mail break".** The tree already *withholds* a
  corpus from the agent: history and bookmarks are unreachable from the planner/reader/judge and
  there is a standing test that a secret filled into them never appears in a model request
  (`README.md:435-444`). Mail adopts that invariant verbatim.
- **Per-profile isolation with real enforcement**: separate session partitions, proxy-per-profile,
  the loopback-and-port-refusal rule, sender-checked IPC, deletion semantics
  (`profiles.ts`, `runtime.ts:2273`).
- **An audit log that already records egress decisions** (`core/audit.ts`) — mail's channel gets
  its own entries rather than a new logging system.
- **Panels, rail, chord table, keybinding map, Quick Commands** (tickets 11/14/15/17) — the mail
  entry points plug into these rather than growing a second command system.
- **`core/downloads.ts`** — attachments reuse the download path and its warnings.

---

## Platform feasibility (probed on this box today, not assumed)

| question | probe | result |
|---|---|---|
| Is there a SQLite available without a native build? | `node:sqlite` (Node 24.21 / Electron 44.4.5 main process) | **OK** — `DatabaseSync, StatementSync, Session, constants, backup`; SQLite 3.53.4; **FTS5 OK**; `json_extract` OK |
| Can we store secrets encrypted? | `require('electron').safeStorage` | `isEncryptionAvailable=false`, backend=`basic_text` — **there is no OS keyring on this box**; safeStorage would encrypt with a hardcoded key, i.e. it would be a lie to call it protected |
| Does Node 26 (host) have the same? | `node -e "require('node:sqlite')"` | OK — so unit tests can exercise the store outside Electron |
| Can Electron dial IMAP/SMTP itself? | `net`/`tls` are Node core in the main process | yes, and it does **not** pass through the profile's `session` proxy — deliberate and documented below |

Consequences, stated plainly rather than discovered later:

1. **Store = `node:sqlite`, zero native dependencies, FTS5 search.** No better-sqlite3 build, no
   new RAM-heavy dependency, and the store is unit-testable without launching Electron.
2. **Secret storage is a real fork in the road, and the honest default on this box is a
   passphrase.** Three modes: `passphrase` (default; argon2id KDF → AES-256-GCM, derived key in
   memory for the session, secret material never written in the clear), `os` (only offered when
   `safeStorage.isEncryptionAvailable()` is true, i.e. a real Secret Service backend), and
   `plaintext` (**explicit opt-in with a UI warning** — what most desktop mail clients do on
   Linux). `safeStorage` on `basic_text` is treated as **not** a keyring. A spike (00) decides
   whether a pure-JS D-Bus Secret Service client is worth wiring before falling back to
   `passphrase`.

---

## The cross-cutting rule (the one that matters)

**Mail is the lethal trifecta in one object: private data + untrusted content + outgoing
channels. It is therefore never an agent input.** Frozen for the whole program:

1. **No mail text reaches the planner, reader or judge; no tool exists to read mail.** Same
   invariant as history/bookmarks, with the same test idiom: fill the store with a marker string,
   run a task, assert it appears in **no** model request.
2. **A mail body is never parsed for links, never auto-fetched, never rendered as HTML, never
   executed.** Remote content in a message is shown as a banner, never loaded.
3. **The browser's pages have no path to mail.** The mail window is a *separate BrowserWindow*
   whose IPC handlers refuse any sender that is not that window; a web panel, a tab, the start
   page and a page script all get `unknown sender`.
4. **The mail channel is refused while an agent task runs** or a confirmation dialog is pending —
   sending, fetching an attachment, and every state change (move/delete/label/flag). Same posture
   as translate (25) and `window.print()` (`runtime.ts:990`), with the reason shown in the UI.
5. **Mail egress is a separate, explicitly-configured channel**, not the browser egress proxy. The
   sockets are created by main with Node `tls` (implicit TLS 993/465, STARTTLS 587), which the
   profile `session` never sees — that is what keeps mail working during a task, and it is why the
   audit log records every connection (host, port, TLS version) and every send (envelope
   recipients, message size) as its own event class.
6. **`mail.sqlite` and every secret are per profile and are deleted with the profile** (the
   existing delete path + its verification test). Profile bundles (30) never carry accounts,
   secrets, or the store; import refuses them.
7. **Mail is not a panel section.** It is a window. `PanelId` (`renderer/panels.ts:21`) stays
   chrome-data-only, so RULE 4 stays true *by construction* rather than by review: nothing that
   renders inside the shared panel column can ever hold message text.

---

## Waves and tickets

Sequenced so each ticket is a vertical slice and every wave is independently usable. Ticket
numbers continue the parity plan (33 was its last).

### 00 — Prep: secret-store decision + IMAP/SMTP fixture servers + the "no mail in a model" test skeleton
**Delivers:** (a) the secret-store mode decided by measurement (probe `safeStorage` backends; spike
a pure-JS D-Bus Secret Service read; write the decision down either way); (b) **fixture servers**
in `test/helpers/` — a minimal IMAP (with IDLE + STARTTLS) and SMTP server, in the same spirit as
the existing fixture HTTP/attacker servers, so mail is testable with **no network and no account**;
(c) the empty test that will fail if mail ever reaches a model.
**Why first:** everything below depends on the secret mode, and no mail ticket can be verified
without the fixtures.
**Blocked by:** none.

### 34 — Mail store foundation (no network at all) — **DONE 2026-10-02**
**Delivers:** `src/core/mail/store.ts` — `node:sqlite`, schema + migrations, WAL, FTS5 index over
subject/from/to/body-text, per-profile path (`join(profileDir, 'mail.sqlite')`, 0600), message
model, folder/thread/label/flag tables, caps (per-account size ceiling, per-message size, index
budget), and a body-to-text normaliser that strips HTML with no parser and no fetch.
**Gate constraints:** the store holds no secret and has no network code; a unit test asserts the
file contains no credential substring and no gate/taint field can be represented.
**Acceptance:** migrations from empty and from a v1 db; FTS5 search returns hits with snippets;
0600 verified; a 250 MB synthetic mailbox stays inside the ceiling.
**Blocked by:** 00.

**BUILT (2026-10-02).** `src/core/mail/store.ts` (≈1 100 lines), `test/unit/mail-store.test.ts`
(42 tests). Files as planned, plus `schemaSql()` / `columnNames()` accessors whose only purpose is to
let a test assert what the store CANNOT represent.
- Store: `node:sqlite` (probed: Electron 44 main process = Node 24.21, SQLite 3.53.4, **FTS5 and
  json1 present**), WAL, `user_version` migrations that refuse a newer store, 0600 on the db AND its
  `-wal`/`-shm` sidecars, `busy_timeout`, foreign keys on.
- Tables: account / folder / message / attachment / label / message_label / filter / message_fts.
- Decisions worth keeping: **`seen` and `readFlag` are separate** (Vivaldi's unseen vs unread is a
  data distinction, not a UI one); **no HTML is stored** — `htmlToText` strips scripts/styles/
  comments *before* decoding entities, so an encoded `<script>` survives as literal text that the UI
  sets as a text node; `remoteContent` is a FLAG so the UI can say "remote content was not loaded"
  instead of pretending the message was flat; attachments are **metadata only** (bytes are never in
  the store and never fetched implicitly); `deleteMessages` is the only hard delete and it demands
  `confirm: true`, so "delete" in the UI is a move to Trash and only emptying Trash lands there.
- `ftsQuery` is written as an injection boundary and its test says so: every token is stripped to
  letters/digits/underscore and emitted as a prefix term, and FTS5's reserved words (`AND OR NOT
  NEAR`) are **dropped rather than escaped** — `OR*` is a syntax error, and a search box that throws
  on `" AND "` is a bug. A test feeds `"`, `*`, `NEAR(`, `^(x)$`, `\`, `%` and asserts no throw.
- Two real bugs the tests caught and the code now encodes:
  1. `pragma_table_info("x")` treats the argument as an IDENTIFIER; it must be single-quoted.
  2. Writing 0600 *after* opening leaked a window where SQLite had already created the file 0644
     under the umask. The file is now created 0600 (and chmod-ed) BEFORE `DatabaseSync` opens it.
- **Honest limit:** `move()` keeps the row's uid while the server will have given the message a new
  one; `rekey(id, folder, uid)` exists for the sync layer (36) to reconcile, and the comment says so
  rather than hiding it. `MAX_MESSAGES` = 500 000 and a 4 GB default ceiling are enforced through
  `canStore()`, which an update to an existing message bypasses (no data loss when the store is full).
- Verified: `npm run typecheck` clean; `npx vitest run` = **324/324 pass, 20 files** (282 before +
  42 new). The invariant test fills the store with a canary in subject/from/body/attachment name/
  label/filter and asserts it appears in **no** planner/reader/judge prompt or tool schema, that no
  mail tool exists, that the agent modules import nothing from `mail/`, and that `preload.ts` (the
  renderer bridge) does not mention mail at all.

### 35 — Accounts: IMAP/SMTP credentials, OAuth, and the secret store — **SPLIT 2026-10-02**
**Delivers:** account records in `settings.json` (**host, port, TLS mode, username, folder
mappings, identity/display name, `authKind: 'password' | 'oauth' | 'app-password'`** — never a
secret), the secret blob in the store from 00, "Test account" with a precise error taxonomy
(DNS / TCP / TLS / auth / folder), and the audit entries for a connection test.
OAuth = authorization code + PKCE, browser-flow, refresh token in the secret store, **never** in
the browser cookie jar. Explicit no-JMAP decision (no server to implement against; noted as a
limit, not a bug).
**Gate constraints:** a connection is refused while a task runs; the UI refuses to save an account
whose secret could not be stored (no silent plaintext fallback).
**Blocked by:** 00, 34.

**BUILT (2026-10-02) as 35a/35b, because the scope was two vertical slices, not one.**
- **35a — the secret store** (`src/main/mail/secrets.ts`). Mode decided by measurement, and the
  measurement is the point: `safeStorage.isEncryptionAvailable()` is **false** with backend
  `basic_text` on this box, i.e. a hardcoded Chromium key. 'os' mode is therefore offered only when
  Electron reports a REAL backend (`gnome_libsecret` / `kwallet*`), passphrase is the default
  (scrypt N=16384 r=8 p=1 → AES-256-GCM, fresh nonce, no OS keyring needed), and plaintext is an
  explicit, warned-about choice — never a silent fallback. A wrong passphrase is proven wrong by
  decrypting a check record, so it fails at unlock with "wrong master passphrase" instead of at the
  server with an auth error. KDF parameters read from the FILE are bounded (a hostile `N = 2^30`
  would otherwise hang the app), and the test for that exists.
- **35b — account records + OAuth + the connection test taxonomy** (`src/main/mail/accounts.ts`).
  A strict zod record (unknown keys refused, no secret field of any name accepted, OAuth endpoints
  must be https, a plaintext-socket password login refused unless it is deliberate), PKCE (S256 +
  state compare, loopback redirect only), and `classifyImapFailure` naming DNS / TCP / TLS /
  greeting / auth / folder as six distinct messages instead of "login failed".
- Three real bugs the tests caught:
  1. `SecretStore.open` touched the file to fix its mode and THEN checked `existsSync` to decide
     whether to read it — so every fresh store looked like an empty existing one and came back
     **locked with no key**. Now "has content" = exists AND size > 0.
  2. `unlock` demanded a passphrase before the `os` branch, making a keyring-backed store
     impossible to open.
  3. `normalizeAccount` rebuilt the record field by field, which meant an unknown key was *dropped*
     rather than refused — the strictness was cosmetic. Unknown keys are now checked against the raw
     input as well, and the comment says why both checks exist.
- The OAuth error strings are deliberately **static**: a failed fetch message can contain the
  request, and the request body holds the authorization code and the client secret. The test
  asserts a thrown `Error` containing both never appears in the returned error.
- Verified: `npm run typecheck` clean; `npx vitest run` = **358/358 pass, 21 files** (324 before +
  34 new).
- **Still open for ticket 36** (the real socket layer needs a transport, so it cannot live here):
  the live `ImapProbe` implementation, the audit entries for a connection test, and the settings
  UI that hosts the account editor and the unlock prompt. `testAccount()` takes an injected probe
  precisely so those can land in 36 without re-testing this.

### 36 — IMAP core: sync, IDLE push, offline — **BUILT 2026-10-02**
**Delivers:** `src/core/mail/imap.ts` + `src/main/mail/` — connect/login, capability handling
(IMAP4rev1, IDLE, UIDPLUS, MOVE), folder listing, header sync then body-on-demand, push via IDLE
with exponential-backoff reconnect, UIDVALIDITY change → full folder resync, an outbox that
survives a restart, and a per-account connection state machine surfaced in the UI ("offline" is a
state, not an error dialog).
**Gate constraints:** rule 5 — the socket is main-process `tls`, audited on open/close; rule 4 —
refused while a task runs (the connection is dropped, not queued, and a background resync that
would start mid-task is deferred).
**Acceptance:** against the fixture server — initial sync, incremental sync, IDLE push within a
second, reconnect after a server kill, and `UIDVALIDITY` change forcing a resync with no
duplicates.
**Blocked by:** 34, 35.

**BUILT (2026-10-02), with the real socket + outbox still open (see below).**
- `src/core/mail/mime.ts` — headers, RFC 2047 encoded words, quoted-printable, base64, addresses
  (including group syntax and comma-inside-quotes), the MIME tree, and `extractContent`, which keeps
  text + html-for-the-store and reports attachments as **metadata**. All capped (parts, depth, header
  bytes, body bytes) and none of it fetches or renders.
- `src/core/mail/imap.ts` — an incremental parser (literals, chunk boundaries, two responses in one
  chunk, malformed input), a tokenizer, `parseFetch`/ENVELOPE, and the client: greeting, CAPABILITY,
  LOGIN / AUTHENTICATE PLAIN / XOAUTH2, LIST, SELECT/EXAMINE (UIDVALIDITY/UIDNEXT/READ-ONLY),
  UID SEARCH, UID FETCH, UID STORE, UID MOVE with COPY+`\\Deleted` fallback, APPEND, IDLE, LOGOUT.
  The socket is **injected** (`SocketFactory`), so the whole protocol is unit-testable and the
  security decision ("which socket, and is a task running") lives in the caller.
- `src/main/mail/sync.ts` — the sync engine: folder roles from special-use attributes, header sync
  with a **high-water mark from `MAX(uid)`** (not the newest date), UIDVALIDITY change dropping the
  folder and re-syncing, body-on-demand with `seen` vs `readFlag` kept distinct, flag push, move with
  `rekey` from COPYUID, and IDLE push with bounded backoff (`nextBackoff` is pure, so it is tested
  without waiting).
- `test/helpers/fake-imap.ts` — a scriptable IMAP server, and an ATTACKER: it can lie about a literal
  size, drop mid-command, greet with BYE, refuse auth, and push unsolicited EXISTS.
- **The rule holds and is tested**: `connect`, `syncAll` and `fetchBody` all refuse while a task runs,
  the refusal is reported with its reason, nothing is written to the socket, and no work is queued
  into the refusal (a test flips the gate and shows the next explicit call connects).
- Nine real bugs the tests caught, each now encoded in the code it belongs to:
  1. `tokenize` consumed a quoted string's characters without appending them — **every** quoted token
     came back empty (subjects, addresses, everything).
  2. Literal placeholders were resolved against one shared literal array, so a batched FETCH returned
     the FIRST message's body for every message. Responses now carry their own literals.
  3. `onResponse` stripped the leading `*` from untagged text, which silently broke every matcher
     (SEARCH, SELECT, LIST).
  4. The literal header was written on a second line instead of on the command line (a protocol error).
  5. ENVELOPE indices were off by one: `from` is index 2, not 3.
  6. An unquoted `NIL` in an address came back as the name "NIL".
  7. `UID SEARCH ALL <range>` is not valid syntax; the range IS the key.
  8. `idleDone()` sent DONE before the server had accepted IDLE, so an early stop left the idle
     pending until its 25-minute timeout.
  9. `socket.onClose` dropped the error, so every dropped connection read as "connection closed".
- Verified: `npm run typecheck` clean; `test/unit/mail-imap.test.ts` + `mail-sync.test.ts` = **91
  tests**, plus the full-suite count in the plan's ground-truth table.
- **Still open for 36b**: the real `createConnection`/TLS socket factory (main-process `tls`, implicit
  vs STARTTLS, audited), the outbox that survives a restart (that needs compose, so it lands with 38),
  and the settings/UI surface. `SyncDeps.makeSocket` is the seam they plug into.

### 37 — Mail window: rail entry point, three-pane UI, threading, search, saved searches — **BUILT 2026-10-02**
**Delivers:** a separate `BrowserWindow` (chrome DOM, **no** `<webview>`, remote content off) with
the rail button + `Ctrl+Shift+M` (chord table + keybinding map, one entry, both entry points);
account/folder tree; the Vivaldi view toggles (unseen / unread / read, custom folders, mailing
lists, feeds, junk, archive, trash) as a drop-down **or** icon row per the target screenshot
(measure it, do not guess — the same rule as `docs/target-ui.md`); message list with per-message
threading; message view toolbar (Reply / Reply All / Forward / Read-Unread / Move / Flag / Label /
Spam / Archive / Trash); search field with `from:` `to:` `subject:` `body:` and capitalised
`AND` / `OR` / `NOT`; **save a search as a filter** (Vivaldi's own feature) stored as a view.
Both counters ("unseen" = never seen, "unread" = seen but not dealt with) are a first-class
distinction in the schema, not a UI convention.
**Gate constraints:** rule 3 (separate window, sender-checked), rule 4 (window actions refused
during a task), rule 2 (a body is only ever text nodes).
**Blocked by:** 36.

**MEASUREMENT REQUIRED BEFORE BUILDING (done):** `docs/target-mail-ui.md` was written from the user's
Vivaldi Mail screenshot by the `target-ui.md` process (scale factor, numeric column boundaries, a ruler
overlay read back with vision). Ticket 37 was built against those numbers.

**BUILT (2026-10-02).** New files: `src/core/mail/ui.ts` (the pure model),
`src/main/mail/window.ts` (the window + its IPC), `src/main/mail-preload.ts` (a mail-only bridge),
`src/renderer/mail.{html,css,ts}`, `test/unit/mail-ui.test.ts` (32 tests), `test/e2e/mail.spec.ts`
(6 tests), `scripts/mail-shot.mjs` (renders the real window for review).
- **The window is separate, and that is the security decision**: message text never shares a document
  with the agent panel's chrome. The mail window has its own preload exposing only `mail:*`, and every
  handler resolves the window from the SENDER, so a tab, a panel or the start page calling `mail:*`
  gets `unknown sender`. `test/unit/ipc-channels.test.ts` now also asserts the mail preload's channel
  list matches `MAIL_CHANNELS` exactly, carries no chrome channel, and has no event subscription.
- Geometry from the measurement: tree 206, list 242, reading pane the rest, 68 px row pitch. The e2e
  asserts the rendered column widths against those numbers.
- Rail: the mail button (with the unread badge the reference screenshot shows) is in the rail's top
  group and routes through the ONE chord dispatcher. **`RAIL_WIDTH` corrected 27 → 51** and
  `--rail` 27px → 51px in styles.css (the measured 50.8), with a unit test that the two cannot drift.
- The view model implements the reference's own vocabulary: ONE `Unread` read-state row (an earlier
  draft invented an `Unseen` row beside it — the screenshot does not have one), the two chips per row
  (unread-ish, then total), the six view toggles in the reference's order, and `from:`/`to:`/
  `subject:`/`body:` search with capitalised `AND`/`OR`/`NOT`.
- Search is an injection boundary: the parser reduces every value to letters/digits/underscore and
  emits column-filtered prefix terms, and FTS5's reserved words are dropped. `mail:search` refuses to
  silently invert a leading `NOT` (it returns `refused`, because `NOT x` cannot be expressed as a
  MATCH and returning `x` would mean the opposite of what was asked).
- Store additions this ticket needed: `MessageRow.threadId` on the row model, and `searchExpr()` —
  `search()` runs its input through `ftsQuery`, which strips column filters, so a `from:` search
  through it silently returned nothing. Both are covered by tests.
- Bugs the tests/e2e caught: the rail button called the chord channel with the WRONG SIGNATURE
  (`chord` is `(key, mods)`, and `{key:'m',control:true}` as the first argument silently answered
  `{handled:false}` — the mail window simply never opened); the e2e polled on window COUNT instead of
  URL, which passes before the document loads; the window's own screenshot is 900x500 because Playwright's
  capture does not reflect the real 1440x920 window.
- Verified: typecheck clean; unit **500/500** (460 before + 32 UI + 8 allowlist/rail tests);
  `mail.spec.ts` **6/6**; full e2e suite re-run recorded in the ground-truth table.
- **Honest limits:** the tree renders empty until an account is added (no fixture account is seeded);
  the reading pane shows text only, so a message whose HTML had no text part renders the stripped
  text with the remote-content banner; compose/send, filters-with-actions, labels and POP3 are
  tickets 38-42; and the window's visual result is verified by screenshot, not by pixel assertions,
  beyond the three column widths.

### 37b — Import accounts from the user's himalaya config — **BUILT 2026-10-02**

**Why it exists:** the mail window shipped with an empty account list, and the user asked why. The
answer was "nothing has added one" — but the values were already on disk in
`~/.config/himalaya/config.toml` (18 accounts), so making the user retype eighteen host/port/TLS/login
triples was pointless work. This ticket reads that file.

**Files:** `src/main/mail/import.ts` (parser + plan), `mail:import-scan` / `mail:import-apply` in
`src/main/mail/window.ts`, an `Import` toolbar button and a selectable account list in the account
modal, `test/unit/mail-import.test.ts` (17 tests, including two that run against the REAL config).

**BUILT (2026-10-02).** Decisions worth keeping:
- **The credential never crosses the bridge.** `mail:import-scan` returns account RECORDS and caveats
  only; `mail:import-apply` re-reads the file itself and writes the secrets. A password therefore never
  reaches a renderer, not even as a variable the UI could log. Tests assert the record has no
  password-shaped field and does not contain the secret VALUE (`authKind: 'password'` is the auth kind
  and is meant to be there — the test asserts on fields and values, not the word).
- **`password.cmd` is reported, never executed.** Running a shell command named by a config file is a
  capability this app does not want; those accounts import with no credential and say so.
- **STARTTLS is handled honestly per account**: an IMAP account on 143 is SKIPPED with the reason (this
  build opens implicit TLS only), and an account whose IMAP is fine but whose SMTP is `smtp://…:587`
  (both Gmail accounts here) imports read-only with a note that SENDING is unavailable until ticket 38
  can speak STARTTLS. A silent failure at sync time is the alternative.
- **The parser is a strict subset of TOML**, not a TOML library: accounts tables, dotted keys, quoted
  values with escapes and `#` inside them, bounded at 64 accounts, first-value-wins on a duplicate key.
  Nothing is `eval`ed and no key path is dynamic.
- **Dry-run against the real config: 18 importable, 0 skipped** — 2 Gmail (imap.gmail.com:993, each with
  the send caveat) and 16 on one self-hosted James server (implicit TLS, 993),
  every one with a stored password. Verified by screenshot too: the modal lists the config path, "18
  account(s) to import", checked rows with address@host:port, and the Gmail caveats in yellow.
- Verified: typecheck clean; unit **511/511, 26 files**; mail e2e 6/6; full e2e and the RPM recorded in
  the ground-truth table.
- **Honest limits:** Gmail send will not work until 38 implements STARTTLS (implicit SSL on 465 would
  too, but Gmail's config says 587); the importer does not watch the file, so a new account needs
  another click; and `mailbox.alias.*` beyond inbox/sent/drafts/trash is not imported (junk and archive
  default to `Junk` / `Archive`).

### 37c — Mail is a PANEL in the browser window, not a second window — **BUILT 2026-10-02**

**Why it exists:** the user's first two questions about ticket 37 were "why does mail open in another
window" and "i dont see any mail from any accounts". The second is answered above (nothing had synced;
see 37d). The first is a design decision the user rejected, and the user owns that call.

**What changed.** Ticket 37's rule 3 read "a message body must not share a document with the agent
panel's chrome" and I implemented it as a separate `BrowserWindow`. Re-read carefully, the rule is
about the AGENT REACHING MAIL — and the chrome renderer is `contextIsolation` + `sandbox`, has no node,
loads no page, and its bridge is an allowlist. Mail text rendered there reaches exactly as far as the
history and bookmark text already rendered there: a text node, in a document no page can reach. The
separate window bought nothing the renderer's own boundary did not already buy, and it cost the user
the thing they actually wanted. So:

- `src/main/mail/window.ts`, `src/main/mail-preload.ts`, `src/renderer/mail.{html,css,ts}` are DELETED.
- `src/main/mail/controller.ts` replaces them: one `MailController` per PROFILE, constructed by
  `runtime.ts` on first use, registering its channels on the profile's own `on(...)` table. `main.ts`
  already resolves a handler from the SENDING window, so a tab, a web panel or the start page calling
  `mail:*` still gets `unknown sender` / `channel not allowed`.
- `src/renderer/mail-panel.ts` is the panel: the same three-pane UI, imported by `renderer.ts` so it
  ships in the same IIFE bundle. No new window, no new preload.
- The panel is a FULL view, not a 220 px column: `.side.side-wide` sets the width to
  `calc(100vw - var(--rail))` and `library.ts` reports that width as the left inset, because Vivaldi
  Mail is a full pane and three columns do not fit in a rail.

**The rule that is kept.** Nothing PUSHES message text at the renderer. `mail:*` is request/response
only — no mail channel is an event — and the single `mail` event that exists carries one number (the
unread count for the rail chip). `test/unit/mail-store.test.ts` now asserts exactly that, and
`test/unit/ipc-channels.test.ts` asserts the three lists agree (declaration in `MAIL_CHANNELS`, chrome
preload, runtime handlers) with no mail channel doubling as an event.

**Entry points:** the rail envelope (now the mail PANEL button, with the unread chip on it), the panel
button, `Ctrl+Shift+M`, and the menu item — all one action (`mail.open` → `sendUI('shortcut','open-mail')`
→ `panelsUi.toggle('mail')`).

**Bugs this refactor caught:**
- A sed-style id remap during the move overwrote the account form's SAVE handler with the TEST handler
  (`m-acct-test` and `m-acct-save` both end up matching `acct-save` once the old short ids are mapped
  back), so saving an account silently ran a connection test against an id that did not exist yet and
  reported "auth: unknown account". The e2e's `account-chip` assertion caught it.
- Two elements the panel reads had lost their `data-testid` in the move (`mail-unlock-help`,
  `mail-acct-test`), so an assertion waited 30 s for an element that was on screen.
- The keyring report said `"unknown"` because the controller never received Electron's `safeStorage`;
  it now does, so the unlock text names the real backend (`basic_text`), which is the honest thing to
  tell a user who is being asked to invent a master passphrase.

**Honest limit:** the mail panel is inside the same renderer process as the agent panel's chrome. A
renderer-side bug (a shared global, a bad `postMessage`) is now a bug in both, where a separate window
could not have been reached that way. That is the cost of the user's choice, and it is the reason the
push/event ban above is asserted by a test rather than left to review.

### 37d — Sync on open, and a truthful empty state — **BUILT 2026-10-02**

**Why it exists:** after 37b imported 18 accounts, the user still saw no mail. The store was correct
(18 accounts, empty folder table, zero messages) — `syncFolders()` only runs inside a sync, and nothing
ever ran one. Three fixes:
- the panel syncs the SELECTED account once, the first time it is shown, so an empty tree means "no
  mail" rather than "never asked" — deliberately not a sync-all, which would open eighteen connections;
  `Check all` (⇉) is the explicit action for that and reports n/total;
- the empty state distinguishes "no account configured" from "configured, not synced yet";
- the panel refuses to auto-sync while the secret store is locked, because authenticating with no
  credential fails for a reason that has nothing to do with the server.

### 38 — Compose, drafts, outbox, SMTP send
**Delivers:** compose **inside the mail window's chrome** (never a page — that is what removes the
whole class of "hostile draft page talks to the store" problems), plain text v1, quoting,
signature, drafts autosaved to the store, outbox with retry/backoff, Sent reconciliation.
**Gate constraints:** rule 4 — send is refused while a task runs or a confirmation is pending; every
send writes an audit event with the envelope recipients and size. Recipients are user-typed, and
nothing from any page can populate the fields.
**Honest divergence:** no rich-text/HTML compose and no inline drag-drop images in v1 (Vivaldi has
both). Stated in the README, not glossed.
**Blocked by:** 36.

### 39 — Filters and labels
**Delivers:** local filter rules (match on keyword / subject / from / to / cc, actions: add-remove
label, mark read, mark spam, archive, move) evaluated on arrival; coloured labels; "rerun filters"
and "rerun threading" commands. **Keyword round-trip to the server is a probe, not a promise:**
capability-test `PERMANENTFLAGS`/`\Keyword` per server, and only then offer "sync labels with the
server" (Vivaldi's synced labels depend on its server; we have none — that is a limit, not a bug).
**Blocked by:** 36, 38.

### 40 — POP3 + local-archive mode
**Delivers:** POP3 (110/995) as a second account kind, "fetch all, keep on server / delete after N
days", and a **local-only** account kind with no server at all (messages handed to the store by
file import) — which is the mode that survives the product's "no accounts, no server" premise.
Lowest priority; build only if the user wants it.
**Blocked by:** 36.

### 41 — Attachments
**Delivers:** attachment list from the BODYSTRUCTURE, **fetch on explicit click only**, size cap,
streamed through the existing download path (`core/downloads.ts`) with the same warnings, "open
externally" behind a confirmation.
**Gate constraints:** rule 2 — never auto-fetched, never auto-opened; a fetch during a task is
refused.
**Blocked by:** 36.

### 42 — Feeds (optional, user's call)
**Delivers:** RSS/Atom subscriptions stored as messages with `source='feed'` in the same store and
panel, so they search, filter and mark-read like mail (Vivaldi's unification). The existing
`reputation.ts` feed *parser* is not reusable for display (it builds a host set, nothing more) —
say so rather than pretending it is half-built.
**Blocked by:** 34.

### Sequencing / waves
- **Wave A (usable client): 00, 34, 35, 36, 37** — read mail from a real IMAP account.
- **Wave B (a client you can live in): 38, 41, 39** — send, attachments, filters.
- **Wave C (optional): 40, 42.**
Calendar, tasks and notes stay out of scope. Mail sync (multi-device) is out of scope for the
same reason as Vivaldi Sync (31): it needs a server and an account model.

---

## Verification strategy

1. `npm run typecheck`, then the **full** unit suite (count it: currently 282) and the full e2e
   suite (currently 125) — both green, quoted as real numbers in the ticket.
2. Mail logic gets **unit tests with the fixture IMAP/SMTP servers** (00): sync, IDLE, UIDVALIDITY,
   outbox retry, MIME parsing, FTS search, filter rules. These are millisecond tests, where a
   browser-driven test would be minutes.
3. **The invariant test is mandatory in every ticket that can touch message text**: no planner /
   reader / judge request contains any mail body, subject, sender or header — the same shape as the
   history/bookmarks test at `README.md:435-444`.
4. **The adversarial idiom, not a happy path:** script a *hostile message* (subject and body full of
   injection payloads, a tracking pixel, a `javascript:` link, a 200 MB attachment, a body claiming
   to be from the user) and assert the client does not fetch remote content, does not execute
   anything, caps the attachment, and that the guard/planner never see it.
5. Every ticket updates the README's test/count table with measured numbers, and the new "Mail"
   section states the limits honestly (no sync, local-only labels, plain-text compose, `basic_text`
   keyring on this box).
6. Wave A and Wave B end with a `code-review` pass and a `security-design-audit` over the new
   surface (the mail window, the account/secret store, the IMAP client, FTS search).

---

## Decisions only the user can make

1. **Mail window vs panel column** — this program puts mail in its own window (rail button +
   `Ctrl+Shift+M`). The parity plan's panel column stays chrome-data-only. Confirm.
2. **First account to target** — recommended: **your own self-hosted James IMAP/SMTP** (no
   third-party client registration, works with the fixture-server tests), then a generic
   IMAP+app-password account, then Gmail OAuth (which needs a Google Cloud OAuth client; that
   registration is yours to make).
3. **Secret storage** — passphrase (recommended default), OS keyring (not available on this box
   today), or explicit plaintext. Spend a spike on a D-Bus Secret Service client, or go passphrase
   and move on?
4. **Plain-text-only compose** in v1, or is HTML compose required for parity?
5. **Strict isolation confirmed** — mail refused while an agent task runs, and no mail tool for the
   agent, ever. This is the strictest reading; it is also the whole point of the product.
6. **Wave C (POP3, local-archive, feeds)** — build or skip?

---

## Honest limits (stated now, not discovered later)

- **No mail sync** across devices; labels/flags are local unless a server round-trips keywords.
- **No OS keyring on this box** (`safeStorage` backend `basic_text`), so encryption-at-rest depends
  on the passphrase mode until a Secret Service client is wired up — or on plaintext if you choose
  it knowing that.
- **No JMAP, no calendar, no tasks, no notes**, no rich-text compose v1, no message-rule "run a
  program" actions (deliberately: that is a script runner, and this product does not have one).
- **The mail UI's visual outcome is not e2e-verifiable** beyond structure and state (the same limit
  wave 2 recorded for audio chips and CSS injection); layout must be measured from a Vivaldi
  screenshot before building 37.

---

## HTML mail view (2026-10-02, after ticket 37c)

The store no longer drops HTML: `message_html` (schema v2, capped at 2 MB, never indexed, migration
adds the table and old rows fall back to text). `bodyText` stays text-only and remains the search
and fallback source; a text/plain part that is plainly HTML source is stored as html and converted
to text. The HTML is displayed by `src/main/mail/html-view.ts`: one WebContentsView per window,
JavaScript off, sandboxed, no preload, own in-memory `mailview-<profileId>` partition, sanitized
document (`src/core/mail/html.ts`) with a CSP meta first in `<head>`, every request cancelled,
navigation always prevented (http(s) links open a new normal tab through the user path), and drawn
only while the chrome reports the reading-pane rect (`mail:view-rect`, null under any modal/menu)
and main has no overlay or pending confirmation. The HTML never crosses into the chrome renderer.

Remote images: blocked by default for every message. The banner's `Load External Content`
(`mail:view-load-remote`) allows, for that display only, GET images from public http(s) hosts on
default ports — reputation-listed hosts, private / loopback / link-local addresses (also after DNS
resolution) and non-standard ports stay refused, Cookie / Referer / Origin are stripped and
Set-Cookie dropped. Showing another message or reopening this one goes back to blocked, an agent
task starting revokes it, and during a task the action is refused. Not built: a per-sender
"always load" preference (deliberately not persisted).
