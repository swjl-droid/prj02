// Channel layer: webhook secret, update parsing and Bot API calls (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookSecret, isFromTelegram, parseUpdate, telegramClient } from '../lib/channel/telegram.js';

const TOKEN = 'test-token-not-real';

test('the webhook secret is derived, stable, and Telegram-safe', () => {
  const s = webhookSecret(TOKEN);
  assert.match(s, /^[A-Za-z0-9_-]{1,256}$/);
  assert.equal(s, webhookSecret(TOKEN));
  assert.notEqual(s, webhookSecret(`${TOKEN}x`));
  assert.ok(!s.includes(TOKEN));
  assert.throws(() => webhookSecret(''), /TELEGRAM_BOT_TOKEN/);
});

test('only the right header passes', () => {
  assert.equal(isFromTelegram(webhookSecret(TOKEN), TOKEN), true);
  for (const h of [null, undefined, '', 'x', webhookSecret('other'), `${webhookSecret(TOKEN)} `, TOKEN])
    assert.equal(isFromTelegram(h, TOKEN), false, String(h));
});

test('a message and a button tap become plain messages', () => {
  const m = parseUpdate({ update_id: 1, message: { message_id: 1, from: { id: 7123456789, first_name: 'Wei', last_name: ' Ling ' },
    chat: { id: 7123456789, type: 'private' }, caption: 'photo caption' } });
  assert.deepEqual({ ...m }, { channel: 'telegram', account: '7123456789', chatId: 7123456789, private: true,
    text: 'photo caption', action: '', callbackId: null, name: 'Wei  Ling ' });
  const t = parseUpdate({ update_id: 2, callback_query: { id: 'q1', from: { id: 5 }, data: 'agree-update', message: { chat: { id: 5, type: 'private' } } } });
  assert.equal(t.action, 'agree-update');
  assert.equal(t.callbackId, 'q1');
  assert.equal(parseUpdate({ update_id: 3, callback_query: { id: 'q2', from: { id: 5 }, data: 'x' } }), null, 'tap on a message too old to have a chat');
});

test('replies become sendMessage calls; errors never carry the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => (calls.length === 2 ? { ok: false, error_code: 403 } : { ok: true, result: {} }) };
  };
  const tg = telegramClient(TOKEN, { fetchImpl });
  await tg.send(42, { text: 'hi', buttons: [[{ label: 'I agree', action: 'agree:abc' }, { label: 'Read', url: 'https://x' }]] });
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0],
    [{ text: 'I agree', callback_data: 'agree:abc' }, { text: 'Read', url: 'https://x' }]);
  const err = await tg.send(42, { text: 'blocked' }).catch((e) => e);
  assert.equal(err.status, 403);
  assert.ok(!String(err.message).includes(TOKEN) && !String(err.stack).includes(TOKEN));
});
