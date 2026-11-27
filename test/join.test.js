// prj02-R1 US-1 (bot and join flow): access rules and join flow, with the noisy updates real
// families send (lesson Hub row 244): forwarded links, codes in capitals or split by spaces,
// /start@BotName, stickers, captions, group chats, edited messages, other bots, emoji names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, extractCode, command } from '../lib/bot/join.js';
import { parseUpdate } from '../lib/channel/telegram.js';
import { fakeDb } from './fake-store.js';

const CODE = '0123456789abcdef0123456789abcdef';
const CODE_B = 'fedcba9876543210fedcba9876543210';
const cfg = { noticeVersion: 'v1', noticeUrl: 'https://prj02.example/privacy.html', inviteHours: 48, botUsername: 'FamilyBot' };

let upd = 0;
const text = (from, t, chat = { id: from, type: 'private' }, extra = {}) => ({
  update_id: ++upd,
  message: { message_id: upd, from: { id: from, is_bot: false, first_name: 'Wei Ling 🌸', ...extra.from }, chat, text: t, ...extra.msg },
});
const tap = (from, data) => ({
  update_id: ++upd,
  callback_query: { id: `cb${upd}`, from: { id: from, is_bot: false, first_name: '  Ah Hock\t' }, data,
    message: { message_id: 1, chat: { id: from, type: 'private' } } },
});
const run = (db, update) => handle(parseUpdate(update), db.storeFor(), cfg);

test('codes are found however they are typed, forwarded or pasted', () => {
  for (const t of [
    `/start ${CODE}`, `/start@FamilyBot ${CODE}`, `  /START   ${CODE.toUpperCase()}  `,
    `https://t.me/FamilyBot?start=${CODE}`, `Join here: t.me/FamilyBot?start=${CODE} thanks!`,
    CODE.toUpperCase(), `${CODE.slice(0, 8)} ${CODE.slice(8, 16)}-${CODE.slice(16)}`, `\n${CODE}\n`,
  ]) assert.equal(extractCode(t), CODE, t);
  for (const t of ['', '/start', '/start hello', 'I agree', CODE.slice(0, 31), `${CODE}0`, 'zz'.repeat(16), null])
    assert.equal(extractCode(t), null, String(t));
  assert.equal(command('/Invite@FamilyBot now'), 'invite');
  assert.equal(command('invite'), null);
});

test('a stranger is refused, whatever they send, and only counted', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  for (const t of ['I agree', ' i AGREE! ']) {
    const r = await run(db, text(9001, t));
    assert.match(r[0].text, /tap the 'I agree' button/, t);
  }
  for (const t of ['hello', 'I agree to everything', '/invite', '/notice', '/forgetme', '/start', '/start nonsense', '']) {
    const r = await run(db, text(9001, t));
    assert.equal(r.length, 1);
    assert.match(r[0].text, /private family bot/i, t);
  }
  const sticker = await run(db, { update_id: 1, message: { message_id: 1, from: { id: 9001, is_bot: false }, chat: { id: 9001, type: 'private' }, sticker: {} } });
  assert.match(sticker[0].text, /private family bot/i);
  assert.equal(db.refusals, 11);
  assert.equal(db.people.length, 0);
  // Buttons forged by a stranger do nothing either.
  for (const data of ['forget-yes', 'agree-update', 'agree:not-a-code', `agree:${CODE_B}`]) {
    const r = await run(db, tap(9001, data));
    assert.ok(!/welcome/i.test(r[0].text), data);
  }
  assert.equal(db.people.length, 0);
});

test('a join link shows the data notice; joining needs the I agree button', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  const [notice] = await run(db, text(7123456789, `/start ${CODE.toUpperCase()}`));
  assert.match(notice.text, /Tan family/);
  assert.match(notice.text, /privacy\.html/);
  assert.match(notice.text, /AI/);
  assert.deepEqual(notice.buttons[0].map((b) => b.label), ['I agree', 'No thanks']);
  assert.equal(notice.buttons[0][0].action, `agree:${CODE}`);
  assert.ok(notice.buttons[0][0].action.length <= 64, 'Telegram button data limit');
  assert.equal(db.people.length, 0, 'nobody joins before agreeing');
  // Typing 'I agree' instead of tapping does not join.
  await run(db, text(7123456789, 'I agree'));
  assert.equal(db.people.length, 0);
  // 'No thanks' keeps nothing.
  const [no] = await run(db, tap(7123456789, 'decline'));
  assert.match(no.text, /not joined/);
  assert.equal(db.people.length, 0);
  // Tapping I agree joins, with the name cleaned.
  const [welcome] = await run(db, tap(7123456789, notice.buttons[0][0].action));
  assert.match(welcome.text, /Welcome, Ah Hock\. You have joined/);
  assert.equal(db.people.length, 1);
  assert.equal(db.consents[0].version, 'v1');
  // The link is spent: a second account cannot use it.
  const [used] = await run(db, tap(5550001111, notice.buttons[0][0].action));
  assert.match(used.text, /already been used/);
  const [used2] = await run(db, text(5550001111, `/start ${CODE}`));
  assert.match(used2.text, /already been used/);
  assert.equal(db.people.length, 1);
});

test('expired and unknown links are refused with a clear reason', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE, true, -1);
  assert.match((await run(db, text(1, `/start ${CODE}`)))[0].text, /expired/);
  assert.match((await run(db, text(1, `/start ${CODE_B}`)))[0].text, /not valid/);
});

test('members: admin invites, others cannot; tapping I agree twice is harmless', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  await run(db, tap(100, `agree:${CODE}`));
  const [again] = await run(db, tap(100, `agree:${CODE}`));
  assert.match(again.text, /you are in the family bot/);
  const [inv] = await run(db, text(100, '/invite@FamilyBot'));
  const link = inv.text.match(/https:\/\/t\.me\/FamilyBot\?start=([0-9a-f]{32})/);
  assert.ok(link, inv.text);
  // The second adult opens the forwarded link and agrees.
  const [notice] = await run(db, text(200, `Hi! Join: ${link[0]}`, undefined, { from: { first_name: 'Mei', last_name: 'Tan' } }));
  await run(db, tap(200, notice.buttons[0][0].action));
  assert.equal(db.people.length, 2);
  const [no] = await run(db, text(200, '/invite'));
  assert.match(no.text, /Only a family admin/);
  const [help] = await run(db, text(200, 'what can you do?'));
  assert.doesNotMatch(help.text, /\/invite/);
});

test('a changed notice blocks everything until the member agrees again', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  await run(db, tap(100, `agree:${CODE}`));
  const v2 = { ...cfg, noticeVersion: 'v2' };
  for (const t of ['/invite', 'hello', '/forgetme']) {
    const [r] = await handle(parseUpdate(text(100, t)), db.storeFor(), v2);
    assert.match(r.text, /notice has changed/, t);
    assert.equal(r.buttons[0][0].action, 'agree-update');
  }
  const r = await handle(parseUpdate(tap(100, 'agree-update')), db.storeFor(), v2);
  assert.match(r[0].text, /use the bot again/);
  assert.equal(db.consents.at(-1).version, 'v2');
});

test('/forgetme asks first, then deletes; the account is a stranger again', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  await run(db, tap(100, `agree:${CODE}`));
  const [ask] = await run(db, text(100, '/forgetme'));
  assert.match(ask.text, /cannot be undone/);
  assert.equal(db.people.length, 1);
  await run(db, tap(100, 'forget-no'));
  assert.equal(db.people.length, 1);
  await run(db, tap(100, 'forget-yes'));
  assert.equal(db.people.length, 0);
  assert.match((await run(db, text(100, 'hello')))[0].text, /private family bot/);
});

test('group chats, edited messages, channel posts and bots get no answer at all', async () => {
  const db = fakeDb(); db.addFamily('Tan family', CODE);
  await run(db, tap(100, `agree:${CODE}`));
  const group = { id: -1001234567890, type: 'supergroup' };
  assert.deepEqual(await run(db, text(100, '/invite', group)), []);
  assert.deepEqual(await run(db, text(9001, `/start ${CODE}`, { id: -42, type: 'group' })), []);
  assert.equal(parseUpdate({ update_id: 1, edited_message: { text: 'x', from: { id: 100 }, chat: { id: 100, type: 'private' } } }), null);
  assert.equal(parseUpdate({ update_id: 1, channel_post: { text: 'x', chat: { id: -5, type: 'channel' } } }), null);
  assert.equal(parseUpdate(text(100, 'hi', undefined, { from: { is_bot: true } })), null);
  assert.equal(parseUpdate(null), null);
  assert.equal(parseUpdate('garbage'), null);
  assert.equal(db.refusals, 0, 'nothing from a group is even counted');
});
