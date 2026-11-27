// Channel layer for Telegram (Hub row 116). Everything Telegram-specific lives here: reading an
// update, the webhook secret, buttons and the Bot API calls. The bot logic (lib/bot) only sees a
// plain message { channel, account, chatId, private, text, action, name } and plain replies
// { text, buttons }, so a WhatsApp channel can be added later as another file like this one.
//
// Plain English: this file is the bot's ears and mouth on Telegram; the rest is its brain.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CHANNEL = 'telegram';

/**
 * The webhook secret Telegram sends back in every call (header X-Telegram-Bot-Api-Secret-Token).
 * Derived from the bot token, so John stores one secret only; it changes when the token changes.
 */
export function webhookSecret(token) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return createHmac('sha256', token).update('prj02-telegram-webhook').digest('hex');
}

/** True only when the header matches the secret (compared in constant time). */
export function isFromTelegram(header, token) {
  if (typeof header !== 'string' || header.length === 0) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(webhookSecret(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Turns a Telegram update into a plain message, or null for updates the bot ignores
 * (edited messages, channel posts, messages from other bots, updates without a sender).
 */
export function parseUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.callback_query) {
    const q = update.callback_query;
    if (!q.from || q.from.is_bot || !q.message?.chat) return null;
    return {
      channel: CHANNEL,
      account: String(q.from.id),
      chatId: q.message.chat.id,
      private: q.message.chat.type === 'private',
      text: '',
      action: typeof q.data === 'string' ? q.data : '',
      callbackId: q.id,
      messageId: q.message.message_id ?? null, // the tapped message, so its buttons can be replaced (US-9)
      name: displayName(q.from),
    };
  }
  const m = update.message;
  if (!m || !m.from || m.from.is_bot || !m.chat) return null;
  return {
    channel: CHANNEL,
    account: String(m.from.id),
    chatId: m.chat.id,
    private: m.chat.type === 'private',
    text: typeof m.text === 'string' ? m.text : (typeof m.caption === 'string' ? m.caption : ''),
    action: '',
    callbackId: null,
    name: displayName(m.from),
  };
}

function displayName(from) {
  return [from.first_name, from.last_name].filter((s) => typeof s === 'string' && s.trim()).join(' ');
}

/** A Bot API client. `fetchImpl` is replaced in tests. */
export function telegramClient(token, { fetchImpl = fetch } = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  async function call(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    // Never include the URL in an error: it holds the token.
    if (!data.ok) {
      const err = new Error(`telegram ${method} failed`);
      err.type = 'telegram_error';
      err.status = data.error_code ?? res.status;
      throw err;
    }
    return data.result;
  }
  return {
    call,
    /** Sends one plain reply; buttons are rows of { label, action }. */
    send(chatId, reply) {
      const body = { chat_id: chatId, text: reply.text, link_preview_options: { is_disabled: true } };
      if (reply.buttons?.length) {
        body.reply_markup = {
          inline_keyboard: reply.buttons.map((row) => row.map((b) => (
            b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.action }))),
        };
      }
      return call('sendMessage', body);
    },
    /**
     * Replaces the tapped message (US-9): edit = true changes its text and buttons, edit = 'buttons'
     * only its buttons (an empty list removes them).
     */
    edit(chatId, messageId, reply) {
      const markup = { inline_keyboard: (reply.buttons ?? []).map((row) => row.map((b) => (
        b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.action }))) };
      if (reply.edit === 'buttons') return call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup });
      return call('editMessageText', { chat_id: chatId, message_id: messageId, text: reply.text, link_preview_options: { is_disabled: true }, reply_markup: markup });
    },
    answerButton(callbackId) {
      return call('answerCallbackQuery', { callback_query_id: callbackId });
    },
  };
}
