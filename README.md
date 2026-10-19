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

## Scripts and fixes

`scripts/send_text.json` and `scripts/send_media.json` are the active scripts. When a run needs LLM recovery or cannot find an element, the fixer stores a proposal under `state/proposals/`. Proposals are never applied automatically:

```bash
H="Authorization: Bearer $GATEWAY_TOKEN"
curl -H "$H" localhost:4010/v1/proposals
curl -H "$H" -H 'Content-Type: application/json' -d '{"from":"<sender number>","to":"<test number>","text":"dry run"}' localhost:4010/v1/proposals/<id>/dry-run
curl -H "$H" -X POST localhost:4010/v1/proposals/<id>/approve   # or /reject
```

Approval keeps the previous script in `scripts/history/`.
