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
| `lib/bot/` | Bot logic, channel-free: `join.js` join flow and access rules (US-1); `calendar.js` calendar changes by chat, written only after the asking adult's yes (US-2); `interpret.js` the model fills a form, the code checks it; `deps.js` real gateway and Google helpers |
| `api/tick.js` | The scheduler's tick (ADR-02): Supabase Cron calls it every minute; role `app_prj02_job` over `JOB_DB_URL`; sends after commit |
| `lib/trips/` | US-3: `plan.js` leave times, quiet hours, clashes, the US-6 stay rule (code does the sums); `who.js` US-7 who each event is for (family convention, children and aliases); `chain.js` US-8 one adult doing both activities in a row; `ways.js` US-9 the ways of doing a trip (list in `config/settings.json` `trip_ways`) and the 3 options per message, usual choice first; `tick.js` scan, plan round, due messages; `messages.js` texts |
| `lib/bot/limits.js`, `lib/bot/guard.js` | US-4: step and cost caps per model run (one Langfuse session per run); red-team guards (sharing outside the family, instructions in event notes), patterns in `config/settings.json` |
| `lib/bot/plan.js` | US-6: the adult's own plan for a clash ("My own plan…"): the model fills the `trip_plan` form, code checks it and does the times, only the writer's Yes applies it (`plan_decide`) |
| `lib/bot/trips.js` | Taps on 'who takes it?' and clash options (`assign_trips`), and "what's on" answers |
| `lib/route/onemap.js` | Travel time from OneMap per route (drive, public transport; token in memory only); else the family's estimate for that way of travel (`app_prj02.travel_modes`, Hub row 277) |
| `api/test-week.js` | Preview only: create / delete the 10 `[TEST]` events of the US-3 test week |
| `lib/calendar/` | `google.js` Google Calendar through the bot's service account (`GOOGLE_SA_KEY`); `dates.js` dates in the family's time zone |
| `eval/` | Golden set of noisy calendar requests and its checker (with self-test); live run on a preview at `/api/eval-calendar` |
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
4. Secrets (names listed in the ai-platform CLAUDE.md): `TELEGRAM_BOT_TOKEN`, `APP_DB_URL`, `JOB_DB_URL`,
   `GOOGLE_SA_KEY`, `ONEMAP_EMAIL`, `ONEMAP_PASSWORD`, and the gateway's. The webhook secret is derived from the bot token.
5. Children do not use the bot in release 1 (Hub rows 127 and 155). The bot keeps only their names and
   nicknames as an adult enters them (`/children`, data notice v2), to know who each event is for.
7. No bot-started message in quiet hours; each message is claimed once (never sent twice); drop-off and
   pick-up reminders exist only after an adult's tap.
8. Limits (US-4): every model call goes through `withRunLimits` (8 steps, US$0.50 per run); the chat bot
   checks `budget()` (paused, US$5 per family per 7 days) before a model call; the scheduler sends at most
   `max_messages_day` (30) bot-started messages per family per day and nothing while paused (database).
   A request to share outside the family is refused in code, never sent to the model.
6. The model only fills a form (`calendar_request` tool); code checks every field and decides. No calendar
   write without a `decide_change()` yes from the adult who asked.
