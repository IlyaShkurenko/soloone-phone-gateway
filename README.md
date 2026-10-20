# soloone-phone-gateway

Sends WhatsApp messages from Android phones over ADB. See `docs/features/phone-gateway.md`.

## Run

```bash
cp .env.example .env   # fill GATEWAY_TOKEN, MULTILOGIN_TOKEN, OPENROUTER_API_KEY
npm install
npm run dev
```

`adb` must be on the PATH or set in `ADB_PATH`. For non-English text install ADB Keyboard on each phone (`adb install ADBKeyboard.apk`); the gateway switches to it only while typing.

## Devices

`devices.json` (not in git; copy `devices.example.json`) maps a WhatsApp number to a phone:

```json
[
  { "phone": "447700900001", "driver": "multilogin", "profileId": "<multilogin mobile profile id>" },
  { "phone": "447700900002", "driver": "physical", "adbAddress": "100.64.0.12:5555" }
]
```

Moving a number to another phone means editing this file. The backend does not change.

## CI and deploy

Every push to `main` runs `npm run build` and `npm test` in GitHub Actions; a green run deploys to Hetzner over SSH (`.github/workflows/ci-and-deploy.yml`). The daily screen check runs on the test phone from Actions at 06:00 UTC (`.github/workflows/selftest.yml`) and fails the run when a step breaks. Both need the repository secrets `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY` and the variables `DEPLOY_ENABLED=true`, `SELFTEST_FROM`, `SELFTEST_TO`, `SELFTEST_REACT_TEXT`.

## Daily screen check

A dedicated test phone runs every flow without sending, so a WhatsApp update that moves a button is noticed before customers are affected:

```bash
npm run selftest -- --from 447832694090 --to 447832610633 --react-text "selftest anchor"
pm2 start npm --name soloone-phone-selftest --cron "0 6 * * *" --no-autorestart -- run selftest -- --from 447832694090 --to 447832610633
```

The report is in `state/selftest/latest.json`; a failed check names the script step that broke.

## Scripts and fixes

`scripts/send_text.json` and `scripts/send_media.json` are the active scripts. When a run needs LLM recovery or cannot find an element, the fixer stores a proposal under `state/proposals/`. Proposals are never applied automatically:

```bash
H="Authorization: Bearer $GATEWAY_TOKEN"
curl -H "$H" localhost:4010/v1/proposals
curl -H "$H" -H 'Content-Type: application/json' -d '{"from":"<sender number>","to":"<test number>","text":"dry run"}' localhost:4010/v1/proposals/<id>/dry-run
curl -H "$H" -X POST localhost:4010/v1/proposals/<id>/approve   # or /reject
```

Approval keeps the previous script in `scripts/history/`.
