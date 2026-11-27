# prj02: Family orchestrator — rules for every session

The rule book is **[swjl-droid/ai-platform](https://github.com/swjl-droid/ai-platform) `CLAUDE.md`**
(database rules 1-7, tenant separation, keys and secrets, gateway copy route A+, forget me, secret
scan, lint, working with John). Read it first; this file only adds what is specific to prj02.

## Where things are

| Path | What |
|---|---|
| `api/telegram.js` | Telegram webhook: secret header check, then one database transaction per message |
| `api/telegram-setup.js` | Points the bot at production, sets commands and the profile texts with the privacy link (production only, no input) |
| `lib/channel/telegram.js` | Channel layer (Hub row 116): everything Telegram-specific; a WhatsApp file can sit beside it later |
| `lib/bot/` | Bot logic, channel-free (`join.js`: join flow and access rules, prj02-R1 US-1) |
| `lib/db.js` | Role `app_prj02_bot` over `APP_DB_URL`, certificate checked; `begin_request()` per message (Hub row 249) |
| `config/settings.json` | Every number a setting (Hub row 128): notice version, invite hours, ... |
| `public/privacy.html` | Privacy and data notice (shared 10-section template, Hub row 142); bump `notice_version` when it changes |
| `lib/gateway/` | Stamped copy of the ai-platform gateway: never edit here |
| `test/` | `node --test 'test/*.test.js'` (CI job "Bot tests"), with noisy real-world inputs (Hub row 244) |

## prj02 rules

1. The bot never names a person or family to the database: it passes the channel account to
   `app_prj02.begin_request()`; reads go through RLS, changes through `app_prj02` functions only.
2. Private chats only; in a group the bot stays silent.
3. Nothing personal in logs: error kinds only, never message text, names or account numbers.
4. Secrets (names listed in the ai-platform CLAUDE.md): `TELEGRAM_BOT_TOKEN`, `APP_DB_URL`, and the
   gateway's. The webhook secret is derived from the bot token.
5. Children do not use the bot in release 1 (Hub rows 127 and 155).
