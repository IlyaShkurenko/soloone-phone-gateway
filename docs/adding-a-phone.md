# Adding a phone to the gateway

Everything a new physical phone needs before it can send and receive for an account. Each item comes from a real failure; the date says when it happened. Add to this list when a new kind of failure shows up.

## On the phone (the person who has it)

1. **No screen lock.** Settings > Lock screen > Screen lock type > None. With a lock, the gateway stops at the lock screen and nothing is sent. (2026-11-12: a new phone locked itself in the afternoon; every send failed with "Phone is locked on keyguard".)
2. **Debugging allowed for our server, for good.** When the phone asks "Allow debugging?", tick "Always allow from this computer" and tap Allow. Without the tick the permission is lost after a restart and the phone shows `unauthorized`. (2026-11-12: four phones lost it at once after a restart.)
3. **ADB Keyboard installed.** Without it the gateway types only plain Latin letters: any message with £, an emoji or a curly apostrophe fails with "Non-ASCII text needs ADB Keyboard". On Samsung, first switch off Settings > Security and privacy > Auto Blocker, then install `adbkeyboard.apk` (the file is in `/opt/soloone-phone-gateway/` on the server). Nothing needs to be switched on after installing: the gateway selects it while typing. (2026-11-12: a new phone came without it.)
4. **WhatsApp logged in and its notifications on.** Incoming messages are read from the notifications (PGW-23).
5. **Screen stays on while charging.** Developer options > Stay awake (from the server: `adb -s 10.8.0.N:5555 shell settings put global stay_on_while_plugged_in 7`). When the screen goes dark right after Send, the gateway cannot see the sent message and reports it as uncertain. (2026-11-12: a new phone had it off; sends ended with "Send was pressed but the sent bubble was not confirmed".)
6. **Always on charge, on Wi-Fi and on the VPN.** The phone must answer `ping 10.8.0.N` from the server at all times. (2026-11-12: phone 1 dropped off the VPN for about half an hour.)

## On the server

7. **Check the phone answers:** `adb -s 10.8.0.N:5555 shell echo ok` must print `ok` (not `unauthorized`, not `not found`), and `adb -s 10.8.0.N:5555 shell pm list packages com.android.adbkeyboard` must list the package.
8. **Register it in `devices.json`** with its phone number and `adbAddress`. Leave out `captureIncoming` for a phone that serves an account: `captureIncoming: false` means its incoming messages are never read, so the account's AI never answers. Use `false` only for a phone that plays the customer in tests. The gateway reads the file on every request; no restart is needed.

## In the backend

9. **Point the account at the phone:** in `whatsapp_instances` for that account set `phone` to the number, `outgoing_transport` and `incoming_transport` to `phone_gateway`, and `usage_mode` to `ready` (in `warming` the AI does not answer).
10. **Make sure the backend sees it online:** `provider_metadata->'phoneGateway'->>'online'` must be `true`, or sending is refused for an account whose state is not `authorized`. The gateway reports a phone only when its state changes, so a phone registered before its account was pointed at it stays unreported. Then restart the gateway (`pm2 restart soloone-phone-gateway`) or wait for the next change. (2026-11-12: a new phone had no online status after it was moved to an existing account.)
11. **Bind the SIM as the account's SMS number:** set `users.sms_phone` to the number and `sms_verified_at` to now. Without it the backend drops every SMS the phone reads and cannot send one. The SMS settings screen cannot do it: its verification code goes out through Dinstar, which does not have these SIMs. (2026-11-14: SMS to a new phone vanished; three more accounts had no SMS number.)
