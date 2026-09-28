# guarded-browser

A desktop web browser (Electron + TypeScript) with a built-in AI agent that is **architecturally**
defended against prompt injection. The design assumes the models *will* be fooled sometimes and puts
the security boundary in code: a privileged planner that never reads pages, a quarantined reader with
no tools, a taint/data-flow policy, an action judge, human confirmation, an egress-filtering proxy
and host-reputation feeds, all written to an append-only audit log.

v1. Local models by default (any OpenAI-compatible server), optional cloud fallback, no accounts.

## Quick start

```sh
npm install          # also downloads the Electron binary (postinstall)
npm start            # builds and launches the browser
npm test             # typecheck + unit tests (vitest) + end-to-end tests (Playwright _electron)
npm run smoke:local  # one tiny real task against http://127.0.0.1:1234/v1, skipped if it is down
```

* First launch downloads the guard model (`protectai/deberta-v3-base-prompt-injection-v2`, ~740 MB,
  Apache-2.0, ungated) into `~/.cache/guarded-browser/models` and the reputation feeds (~27 MB) into
  the profile. Until they arrive the UI shows `guard: loading` / the feed status; nothing blocks
  startup.
* The e2e tests run under `xvfb-run` when it is installed (no window on your desktop, works
  headless). Without xvfb they use `$DISPLAY`; with neither they fail with an explanation
  (Fedora: `dnf install xorg-x11-server-Xvfb`).
* `npm test` never talks to a real LLM: every test uses the scripted mock in `test/helpers/mock-llm.ts`.
  The guard test runs the real classifier on CPU (set `GUARDED_SKIP_GUARD_TEST=1` to skip it).

## Architecture

```
                      user task (trusted)                                 audit log (JSONL, append-only)
                            │                                                      ▲ every step
                            ▼                                                      │
 ┌───────────────── PLANNER (privileged LLM, tools) ─────────────────┐             │
 │ sees: task, its own actions, typed reader results, guarded       │             │
 │ element snapshot (role / name / ref). NEVER raw page text.        │             │
 └──────────────┬──────────────────────────────▲─────────────────────┘             │
   proposed     │                              │ typed JSON, tagged untrusted      │
   action       ▼                              │ (+ provenance url/time)           │
 ┌──────────────────────────┐       ┌──────────┴───────────────┐                   │
 │ POLICY ENGINE (code)     │       │ QUARANTINED READER (LLM) │ no tools          │
 │ taint + origin rules     │       │ page text + narrow query │◄── page text ◄── GUARD
 │ always-confirm list      │       │ → JSON, zod-validated,   │    (chunks flagged│ (DeBERTa
 └──────────┬───────────────┘       │ strings capped           │     → withheld)   │  on CPU)
            ▼                       └──────────────────────────┘                   │
 ┌──────────────────────────┐                                                      │
 │ ACTION JUDGE (LLM)       │ task + history + action only; can escalate, never    │
 │ allow / confirm / block  │ downgrade a code decision                            │
 └──────────┬───────────────┘                                                      │
            ▼                                                                      │
 ┌──────────────────────────┐    Approve / Deny / Stop, default-deny on timeout    │
 │ HUMAN CONFIRMATION (UI)  │    shows action, exact values, destination, taint,   │
 └──────────┬───────────────┘    provenance and judge reason                       │
            ▼                                                                      │
 ┌──────────────────────── BROWSER (persist:guarded profile) ─────────────────────┐│
 │ tab WebContentsView; snapshots/actions run in an isolated JS world              ││
 │ will-navigate / will-redirect: page-initiated moves to new origins → confirm   ││
 │ webRequest layer: reputation (interstitial / drop) + taint values in URL/body   ││
 │ forward proxy 127.0.0.1:<ephemeral>: reputation → denylist → task allowlist     ││
 └────────────────────────────────────────────────────────────────────────────────┘│
```

| Layer | Where | Deterministic? |
|---|---|---|
| Planner / reader split | `src/core/planner.ts`, `src/core/reader.ts`, `src/core/agent.ts` | the split is code; the models are not |
| Taint registry + provenance | `src/core/taint.ts` | yes |
| Policy engine | `src/core/policy.ts` | yes |
| Guard classifier | `src/core/guard.ts` | no (probabilistic) |
| Action judge | `src/core/judge.ts` | no; can only escalate |
| Confirmation broker + modal | `src/main/confirm.ts`, `src/renderer/` | yes (default deny) |
| Egress proxy + content filter | `src/core/egress.ts`, `src/main/main.ts` | yes |
| Reputation feeds | `src/core/reputation.ts` | yes (the feeds themselves are third-party data) |
| Audit log | `src/core/audit.ts` | yes |

### 1. Planner (privileged)
Native tool calling (`navigate, click, type, select, scroll, submit, extract, finish`); if the server
returns no `tool_calls` it falls back to a strict `{"action": ..., "args": {...}}` JSON format. It
receives an accessibility-style snapshot built by our code in an isolated world: role, name (≤80
chars, screened by the guard), ref id, input type, link target, form target. Only the newest snapshot
stays in its context. Step limit and task timeout come from settings.

### 2. Quarantined reader
No tools. Gets guarded page text (≤12k chars) wrapped in `<page_content>` plus the planner's query
and a flat schema (`{"price":"number","currency":"string"}`, types `string | number | boolean |
string[] | number[]`, `?` for nullable). Output is validated with a strict zod schema (unknown keys
rejected, one retry), strings capped at 200 chars and arrays at 20, re-screened by the guard, then
registered in the taint registry as `untrusted` with `{source: reader, url, timestamp}`.

### 3. Taint / data-flow policy (code)
* Text the planner types or navigates to is **trusted only if it appears verbatim in the user's
  task**; otherwise it is untrusted (its provenance points at the reader value it contains, or at
  "planner-generated, context contains untrusted data from <origins>").
* Navigation: new origin not named in the task (and not the tab's start origin / an approved
  origin) → confirm. Untrusted URL while the planner has read content from a *different* origin →
  confirm. `javascript:`, `file:`, `data:` → block.
* Typing/selecting an untrusted value → confirm. Password fields and fields of a form with a
  password → always confirm.
* Submit, submit buttons, and controls named like buy / pay / checkout / send / post / delete /
  login / subscribe / transfer / download / upload → always confirm, showing every field value with
  its taint label. Forms that post to a new origin say so.
* Page-initiated navigations and server redirects to new origins during a task are intercepted
  (`will-navigate` / `will-redirect`) and need confirmation. Popups are denied during a task.
  Downloads during a task are paused until confirmed.
* The judge's verdict is combined by severity: it can escalate `allow → confirm → block`, never
  downgrade.

### 4. Guard
`protectai/deberta-v3-base-prompt-injection-v2` via transformers.js / onnxruntime-node on CPU (2
threads by default). Text is split into ≤200-char chunks with whitespace collapsed (measured: 1000-char
chunks let benign text dilute 2 of 10 injections below threshold; newlines alone swing scores). A
flagged chunk becomes `[content withheld: possible prompt injection]`, is logged with its score, and
the tab gets a warning badge. If the model cannot load the UI shows **guard unavailable** and the
planner is told names were not screened; everything else keeps working.

### 5. Action judge
A separate call with only the task, the action history and the proposed action. Output
`{"verdict", "reason"}`; unparseable or failed → `confirm` (fails toward the human).

### 6. Human confirmation
A modal in the agent panel (browser chrome, not the page): action, target, destination, a table of
exact values with taint label and provenance, reasons, judge verdict, countdown. Approve / Deny /
Stop task. No answer within `confirmTimeoutMs` (default 120 s) = deny.

### 7. Audit log
`<userData>/audit/session-<timestamp>.jsonl`, opened append-only. Events: `task-start/end`,
`planner-action`, `snapshot` (hash), `guard` (scores), `reader` (query, schema, validated output,
provenance), `judge`, `policy`, `confirmation`, `navigation`, `egress` (proxy / webrequest /
reputation / download decisions with host, method, reason, taint ids, feed), `fallback`, `error`.
The agent panel shows it as a timeline (manual-browsing proxy chatter is only in the file).

### 8. Egress filtering (network layer, independent of the agent code)
* **Proxy.** In-process Node forward proxy on `127.0.0.1:<ephemeral>`. The `persist:guarded`
  session is routed through it with `proxyBypassRules: '<-loopback>'` so even localhost traffic
  passes it. Plain HTTP is checked on the full request; HTTPS `CONNECT` on `host:port` only.
  **No TLS interception, no custom CA.**
  * manual browsing: log-only, plus a small denylist (ad/analytics hosts by default);
  * agent task running: **host allowlist** seeded from hosts named in the task + the tab's origin;
    hosts approved in a confirmation are added for the rest of the task. Anything else is blocked,
    audited and listed in the agent panel as `blocked host X (N requests)` with a one-click **Allow
    for this task**. Third-party-heavy sites (CDNs, fonts, APIs on other hosts) will partially
    break in agent mode until you allow those hosts.
  * Host keys are `hostname:port` (default ports filled in). The tests use `127.0.0.1:<p1>` for the
    victim site and `localhost:<p2>` for the attacker, so hostname **and** port differ.
* **Content filter.** `session.webRequest.onBeforeRequest` sees the full URL, method and upload body.
  During a task, a request that contains a taint-registry value (reader output, and user-supplied
  values the agent typed) is held and needs confirmation unless that exact flow (value id → host) was
  already confirmed; denied/timeout → cancelled, and the same flow is not asked again that task.
  Matching normalises case, URL-encoding (`%20` / `+`, double encoding) and base64 (std / no-pad /
  url-safe) and ignores values shorter than 6 chars. Manual browsing: matches are only logged.

### 9. Reputation feeds (network layer, manual and agent mode)
Keyless public feeds, downloaded at startup when older than 24 h and then every 24 h (sequentially,
off the startup path; atomic rename; the last good copy is kept if a download fails, returns HTML,
parses to nothing or shrinks by more than 90%). Checked in the proxy for every request and in the
webRequest layer, before anything else:

| feed | URL | format | entries (2026-09-28) |
|---|---|---|---|
| Hagezi Threat Intelligence Feeds, *medium* | `raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt` | domains | ~850k |
| Phishing.Database active domains | `raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt` | domains | ~392k |
| OpenPhish community | `raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt` | URLs → hosts | ~300 |
| abuse.ch URLhaus host file | `urlhaus.abuse.ch/downloads/hostfile/` (still keyless) | hosts | ~380 |

The full Hagezi TIF (2.3M domains) is available (`wildcard/tif-onlydomains.txt`) but would roughly
double memory; the medium list is the default. The old `domains/tif.txt` path no longer exists.
Matching: exact host plus every parent domain, lowercase, trailing dot and port stripped, IDNA →
punycode. `<userData>/reputation/local-blocklist.txt` and `local-allowlist.txt` are user-editable;
**the allowlist wins**. Google Safe Browsing v4 is an optional provider (settings
`reputation.safeBrowsing`, key only from the env var named there; **disabled by default**; it sends
top-level URLs to Google when enabled).

Decisions: a top-level navigation to a listed host shows a full-page interstitial (*listed as
malicious by &lt;feed&gt;*) with **Go back** / **Proceed anyway**. Proceed is always a confirmation in
the agent panel, is disabled while an agent task runs, and is refused in code if a task is running;
user overrides are ignored in agent mode, so **the agent can never get past a listing**. Subresource
requests to listed hosts are dropped silently. Every hit is audited with the feed name.

## Threat model

**Defended (enforced in code, tested with compromised mock models):**
* Page text / hidden text / alt / aria-label / comments / fake system prompts / review injections
  reaching a model that can act: the planner never sees raw page text; the reader cannot act.
* A fooled planner exfiltrating data by navigation, form fill, submit, or typing untrusted values:
  confirmation with the exact value and destination, default deny.
* Pages moving the agent to attacker origins by redirect chains or JS navigation: intercepted.
* Pages exfiltrating by their own JavaScript (img / fetch / sendBeacon) during a task: blocked by
  the proxy host allowlist, and by the content filter even on allowed hosts.
* Known-bad hosts (phishing / malware lists) in any mode.
* The agent overriding the user's decisions: the judge cannot downgrade, the agent cannot proceed
  past a reputation interstitial, confirmations live in browser chrome.

**Not defended / limitations:**
* **The guard is probabilistic.** It misses some injections and flags some benign text (see the
  table below: a coupon page scores 0.99). It reduces exposure; it is not the boundary. Chunk-level
  withholding also hides benign text next to an injection.
* **A user approving a bad confirmation.** The dialog shows exact values and destinations, but a
  user who clicks Approve lets the flow through. The same for "Allow for this task" on a blocked host.
* **UI spoofing inside pages.** A page can draw a fake dialog inside its own area. Our real dialogs
  are only in the agent panel / interstitial, which pages cannot draw on; users still have to know that.
* **Snapshot names and link targets are untrusted text shown to the planner.** They are truncated
  and guarded, not eliminated; a planner can be steered by them (that is why the policy exists).
* **The planner's answer** is based on untrusted data and can be wrong or manipulated (it is only
  displayed, labelled as such).
* **HTTPS is only filtered by host** (`CONNECT host:port`); no TLS interception. The content filter
  still sees full HTTPS URLs and bodies inside Chromium via webRequest, but only for this session.
* **Taint tracking is value matching**, not full information flow: paraphrased, split, hashed or
  otherwise transformed data (or anything shorter than 6 chars) is not recognised. Snapshot names
  are not in the registry. Page JS that reads a typed value and sends it *after* the task ends
  (manual mode = log-only) is not blocked.
* **Same-origin writes are allowed** (except when they carry registered values): a malicious site
  can still receive whatever the user asked the agent to type into it.
* **Reputation feeds** target phishing / malware, not AI-injection; they lag new domains, and
  attackers cloak (serve clean pages to scanners, bad pages to victims). I know of no public
  AI-injection-specific host feed; none was found while building this.
* **Third-party-heavy sites break in agent mode** until their CDN/API hosts are allowed.
* Denylist/allowlist host matching is on hostnames; IP literals and DNS rebinding are not handled
  specially. WebRTC and DNS-over-HTTPS from pages are not specifically filtered.
* Cloud fallback, when you enable it, sends task, snapshots (planner) and page text (reader) to that
  provider.

## Models and configuration

`<userData>/settings.json` (also editable in **Settings** in the agent panel). `userData` is
Electron's per-app directory (`~/.config/guarded-browser` on Linux; override with
`GUARDED_USER_DATA`).

```jsonc
{
  "models": {
    "planner": {
      "primary":  { "baseURL": "http://127.0.0.1:1234/v1", "model": "default", "extraBody": { "enable_thinking": false } },
      "fallback": { "enabled": false, "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" }
    },
    "reader": { "...": "same shape" }, "judge": { "...": "same shape" }
  },
  "agent": { "maxSteps": 20, "taskTimeoutMs": 600000, "confirmTimeoutMs": 120000 },
  "guard": { "enabled": true, "model": "protectai/deberta-v3-base-prompt-injection-v2", "threshold": 0.5, "threads": 2 },
  "egress": { "denylist": ["doubleclick.net", "google-analytics.com", "googletagmanager.com"] },
  "reputation": { "enabled": true, "feeds": [ /* see table above */ ], "safeBrowsing": { "enabled": false, "apiKeyEnv": "GOOGLE_SAFE_BROWSING_API_KEY" } }
}
```

* `extraBody` is merged into every request (`enable_thinking: false` keeps reasoning models from
  spending their budget thinking).
* The fallback is used only when the primary is unreachable, times out or returns 5xx, and only if
  enabled; the key is read from the named env var at request time and never stored. The agent panel
  shows a **CLOUD FALLBACK ACTIVE** banner while it is in use.
* Environment: `GUARDED_USER_DATA`, `GUARDED_START_URL`, `GUARDED_GUARD=off`,
  `GUARDED_CONFIRM_TIMEOUT_MS`, `GUARDED_MODEL_CACHE`, and the test-only
  `GUARDED_UNSAFE_DISABLE_POLICY=1` (turns the policy engine and judge off, shows a red banner; used
  to prove the egress layer holds on its own).

## Layout

```
src/core/       agent loop, planner, reader, judge, policy, taint, guard, egress proxy, reputation,
                llm client, config, audit (no Electron imports; unit-testable)
src/main/       Electron main: window, tabs (WebContentsView), isolated-world page scripts,
                confirmation broker, egress/reputation wiring, preload bridge
src/renderer/   browser chrome + agent panel (plain DOM)
test/unit/      vitest: policy, taint, reader/llm/planner/judge, egress proxy, reputation, agent loop, guard
test/e2e/       Playwright _electron: benign, attacks, reputation, guard
test/helpers/   mock OpenAI server, fixture + attacker servers, fake browser driver
test/fixtures/  attack and benign pages, fixture threat feed
scripts/        build, e2e runner (xvfb), smoke:local
```

## Test results

TEST_RESULTS_PLACEHOLDER
