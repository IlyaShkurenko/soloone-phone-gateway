# Security

## What the service does with data

The gateway sends WhatsApp messages, reactions, edits, deletions and SMS from Android phones on behalf of the
SoloOne backend. Each request carries the sender and recipient phone numbers and the message text or a media URL.
On physical phones it also reads incoming messages, ticks, contact names and SMS from the screen and the phone, keeps
them on disk and posts them to the backend (`BACKEND_EVENTS_URL`). When an LLM model is configured, a stuck or failed
run sends the phone's UI tree and, unless `LLM_SCREENSHOTS=false`, a screenshot to OpenRouter (`src/llm.ts`,
`src/recovery.ts`, `src/fixer.ts`). The screen can show chat text and phone numbers.

## Configuration and secrets

Read in `src/config.ts` and `src/logger.ts`. Names only; values live in `.env` on the server, which is not in git.

| Variable | Secret | What it is for |
|---|---|---|
| `GATEWAY_TOKEN` | yes | Bearer token the backend sends on `/v1/*`; also the key that signs incoming-media URLs and the token sent to `BACKEND_EVENTS_URL`. Required. |
| `MULTILOGIN_TOKEN` | yes | Multilogin automation token for cloud phones. Empty: a logged-in `xcli` on the host is used. |
| `OPENROUTER_API_KEY` | yes | LLM recovery and script fixes. Empty: both are off and a stuck send fails before Send. |
| `RESEND_API_KEY` | yes | E-mail alerts when a physical phone goes offline. |
| `PORT`, `HOST` | no | Listen address; `HOST` defaults to `127.0.0.1`. |
| `DEVICES_FILE`, `SCRIPTS_DIR`, `STATE_DIR` | no | Device map (`devices.json`, not in git), UI scripts, local state. |
| `ADB_PATH`, `FFMPEG_PATH`, `ADB_IDLE_DISABLE_MS` | no | Tools and ADB idle timeout. |
| `MULTILOGIN_API_URL`, `MULTILOGIN_XCLI_PATH` | no | Multilogin API and CLI location. |
| `GATEWAY_RECOVERY_MODEL`, `GATEWAY_FIXER_MODEL`, `LLM_SCREENSHOTS` | no | LLM models and whether screenshots go to the model. |
| `ALERT_EMAIL`, `ALERT_FROM` | no | Where offline alerts go and their sender. |
| `BACKEND_EVENTS_URL` | no | Where incoming messages and ticks are posted. Empty: they stay on disk. |
| `UI_SNAPSHOT_CACHE_MS`, `FAST_UI_SERIALS`, `FAST_UI_JAR`, `LOG_LEVEL` | no | Screen-reading cache, fast UI reader, log level. |

## Who can call what

From `src/index.ts`:

- The server listens on `127.0.0.1` unless `HOST` says otherwise, so only the backend on the same host reaches it.
- `GET /health` is open.
- `GET /v1/incoming-media/:name` needs `sig`, an HMAC-SHA256 of the file name keyed with `GATEWAY_TOKEN`, compared in
  constant time; a wrong signature or name gets 404.
- Every other `/v1/*` route (messages, SMS, reactions, deletions, edits, script fix proposals and their dry-run,
  approve and reject) needs `Authorization: Bearer <GATEWAY_TOKEN>`, compared in constant time; otherwise 401.
- Request bodies are checked before any phone is touched (phone numbers are 7 to 15 digits, ids match a pattern,
  media URLs are http or https).
- An LLM never presses Send and never applies a script change: fixes are stored as proposals and applied only by the
  approve call (AGENTS.md, `src/safety.ts`, `src/scripts.ts`).

## Where personal data is stored

All under `STATE_DIR` (default `state/`, not in git) on the gateway host:

- `incoming/*.jsonl`, `incoming/events.sqlite`, `incoming/media/`: incoming messages, SMS, ticks and media, with
  phone numbers, sender names and text. Daily files and media are deleted after 14 days; sent events in the queue are
  pruned after 14 days, events still waiting are kept.
- `incoming/names-*.json`, `incoming/profiled-*.json`: contact names and numbers already read per phone.
- `failures/`: a report per failed or uncertain send, with the request (recipient and text), the run trace, the UI
  tree and a screenshot. Deleted after 14 days.
- `ledger/`: per message id, the send state only.
- `devices.json`: the gateway's own phone numbers, Multilogin profile ids and ADB addresses.

Request bodies, message text and tokens are not passed to the logger. Logs do carry phone numbers (see Known gaps).

## Secret scan

`npm run gate` ends with `npm run secret-scan` (`scripts/secret-scan.mjs`): gitleaks over the whole git history,
staged changes and unstaged changes, with values redacted. CI installs gitleaks and runs the gate before every deploy.
Known false positives go in `.gitleaks.toml`, each with a reason; a real secret is removed and rotated, never
allowed.

## Known gaps

- Logs carry phone numbers: customer numbers in `src/incoming.ts:402` and `src/incoming.ts:696` (`to`); the
  gateway's own numbers in `src/index.ts:161` (`from`), as `phone` in `src/incoming.ts` and `src/watchdog.ts`, and in
  logged error messages such as "No phone is registered for <number>" (`src/index.ts:104`, logged at line 175).
  Offline alert e-mails name the phone number and ADB address (`src/watchdog.ts:46`, `src/watchdog.ts:62`).
- With an LLM model configured, screenshots and UI trees that can show chat text and numbers go to OpenRouter
  (`src/llm.ts:21`).
- `media.url` from the backend is downloaded as given; only the `http(s)://` prefix is checked, there is no host
  allow-list (`src/index.ts:58`, `src/media.ts:104`).
- Signed incoming-media URLs never expire, and the signing key is the same `GATEWAY_TOKEN` (`src/incoming.ts:69`,
  `src/index.ts:498`).
- One shared token for both directions: the backend calls the gateway and the gateway calls the backend with the
  same `GATEWAY_TOKEN` (`src/index.ts:38`, `src/incoming.ts:225`).

## Reporting a problem

Report a security problem to the owner of this repository directly, not in a public issue.
