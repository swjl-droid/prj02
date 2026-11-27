// Telegram webhook (prj02-R1 US-1). Telegram calls this for every message to the bot.
// 1. The secret header must match (derived from TELEGRAM_BOT_TOKEN): anything else gets 401.
// 2. The update becomes a plain message (channel layer), the bot logic decides the replies inside
//    one database transaction for that Telegram account, and the replies are sent.
// Always answers 200 to Telegram once the header is right, so a failure is not retried in a loop;
// the function log gets the error kind only, never message text, names or account numbers.
import { isFromTelegram, parseUpdate, telegramClient } from '../lib/channel/telegram.js';
import { handle } from '../lib/bot/join.js';
import { inTransaction } from '../lib/db.js';
import { botConfig } from '../lib/config.js';
import { realDeps } from '../lib/bot/deps.js';

let botUsername;

export async function POST(request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !isFromTelegram(request.headers.get('x-telegram-bot-api-secret-token'), token)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const update = await request.json().catch(() => null);
  const msg = parseUpdate(update);
  if (!msg) return Response.json({ ok: true, ignored: true });

  const tg = telegramClient(token);
  try {
    if (!botUsername) botUsername = (await tg.call('getMe')).username;
    const cfg = botConfig({ botUsername });
    const replies = await inTransaction((store) => handle(msg, store, cfg, realDeps(cfg)));
    if (msg.callbackId) await tg.answerButton(msg.callbackId).catch(() => {});
    // A reply goes to the sender's chat, or (warnings) to another adult of the same family.
    for (const r of replies) await tg.send(r.chat ?? msg.chatId, r);
    return Response.json({ ok: true, replies: replies.length });
  } catch (e) {
    console.error('prj02 telegram webhook failed:', e.type ?? e.code ?? e.name);
    if (msg.private) {
      await tg.send(msg.chatId, { text: 'Sorry, something went wrong. Please try again in a minute.' }).catch(() => {});
    }
    return Response.json({ ok: false });
  }
}
