// prj02-R1 US-7: who each calendar event is for (decision Hub row 298, gap Hub row 290). John's
// convention "[event] - [child]", children named by nickname, short name or full name. Test data:
// John's real titles of 27-29/11 (the names are the nicknames already in the calendar), plus noisy
// variants. The code reads the titles; no model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWho, childPart, parseChildrenCommand } from '../lib/trips/who.js';
import { stays, findClashes, leaveTimes } from '../lib/trips/plan.js';
import { tickFamily } from '../lib/trips/tick.js';
import { handleTripButton } from '../lib/bot/trips.js';
import { handle } from '../lib/bot/join.js';
import { parseUpdate } from '../lib/channel/telegram.js';
import { localParts } from '../lib/calendar/dates.js';
import { fakeTripsDb } from './fake-trips.js';
import { fakeDb } from './fake-store.js';

const TZ = 'Asia/Singapore';
const at = (s) => new Date(`${s}+08:00`);
const ANG = { id: 'aaaa1111-0000-4000-8000-000000000001', name: 'Angela', aliases: ['Ang'] };
const CEL = { id: 'cccc2222-0000-4000-8000-000000000002', name: 'Celine', aliases: ['Cel', 'Ce-Ce'] };
const KIDS = [ANG, CEL];
const CONV = { kind: 'suffix', separator: ' - ' };
const JOHN = { person_id: 'bbbbbbbb-0000-4000-8000-000000000001', display_name: 'John L', can_drive: true, chat: 111 };
const MEI = { person_id: 'dddddddd-0000-4000-8000-000000000002', display_name: 'Mei', can_drive: true, chat: 222 };
const ctx = { convention: CONV, children: KIDS, adults: [JOHN, MEI] };

test("John's real titles: each event is linked to its child or children", () => {
  const cases = [
    ['UWC school day - Ang & Cel', [ANG.id, CEL.id]],
    ['UWC at school until tennis - Cel', [CEL.id]],
    ['UWC Violin - Ang TBC', [ANG.id]],
    ['UWC Tennis - Cel', [CEL.id]],
    ['AF - Ang', [ANG.id]],
    ['Acro @ Dunearn - Ang', [ANG.id]],
    ['Ballet @ River - Cel', [CEL.id]],
    ['Jazz @ Princep - Ang', [ANG.id]],
    ['Art (every 2w) - Cel', [CEL.id]],
    ['Ballet & Jazz @ Forum - Ang', [ANG.id]],
  ];
  for (const [title, ids] of cases) assert.deepEqual(parseWho(title, ctx), { state: 'child', childIds: ids }, title);
});

test('noisy titles: case, dashes, nicknames with a dash, full names, several children', () => {
  const ids = (t) => parseWho(t, ctx).childIds;
  assert.deepEqual(ids('AF - ANG'), [ANG.id]);
  assert.deepEqual(ids('Swim – Celine'), [CEL.id], 'en dash');
  assert.deepEqual(ids('Ballet-Cel'), [CEL.id], 'no spaces, known name');
  assert.deepEqual(ids('Art - Ce-Ce'), [CEL.id], 'a nickname with a dash');
  assert.deepEqual(ids('Tennis - Cel and Ang'), [CEL.id, ANG.id]);
  assert.deepEqual(ids('Piano - ang, cel!'), [ANG.id, CEL.id]);
  assert.deepEqual(ids('Swim - Angela + Celine'), [ANG.id, CEL.id]);
  assert.deepEqual(ids('Dentist - Cel (bring card)'), [CEL.id], 'words after the name');
  assert.equal(childPart('Sports-day', CONV, ['ang', 'cel']), null, 'a dash in an ordinary word is not the separator');
});

test("adults' own events and names the family has not listed", () => {
  assert.deepEqual(parseWho('Dentist', ctx), { state: 'none', childIds: [] });
  assert.deepEqual(parseWho('Board meeting - John', ctx), { state: 'none', childIds: [] }, "an adult's name");
  assert.deepEqual(parseWho('Dinner - Mei & John', ctx), { state: 'none', childIds: [] });
  assert.deepEqual(parseWho('Party - Bobby', ctx), { state: 'unknown', childIds: [], unknownName: 'Bobby' });
  assert.deepEqual(parseWho('Piano - Ang, Cece?', ctx), { state: 'unknown', childIds: [ANG.id], unknownName: 'Cece' });
  // No children listed yet: every timed event is a trip, as before the convention.
  assert.deepEqual(parseWho('Dentist', { convention: CONV, children: [] }), { state: 'legacy', childIds: [] });
});

test('/children: add with aliases, remove, and names checked in code', () => {
  assert.deepEqual(parseChildrenCommand('/children'), { action: 'list' });
  assert.deepEqual(parseChildrenCommand('/children add Celine = Cel, Ce-Ce, 小雪'), { action: 'add', name: 'Celine', aliases: ['Cel', 'Ce-Ce', '小雪'] });
  assert.deepEqual(parseChildrenCommand('/children add  Angela '), { action: 'add', name: 'Angela', aliases: [] });
  assert.deepEqual(parseChildrenCommand('/children remove Celine'), { action: 'remove', name: 'Celine' });
  assert.equal(parseChildrenCommand('/children add <script>').action, 'help');
  assert.equal(parseChildrenCommand('/children add Ang = 987654321').action, 'help', 'numbers are not names');
  assert.ok(parseChildrenCommand(`/children add Ang = ${Array.from({ length: 11 }, (_, i) => `N${'x'.repeat(i)}`).join(', ')}`).action === 'help');
  assert.equal(parseChildrenCommand('/children rename Ang').action, 'help');
});

const ev = (id, title, s, e, loc) => ({ id, summary: title, location: loc, start: { dateTime: `${s}:00+08:00` }, end: { dateTime: `${e}:00+08:00` } });
const UWC = '139654, Singapore 139654';

test("stays per child on John's Friday: Ang stays from school to violin, Cel from school to tennis", () => {
  const day = [
    ev('school', 'UWC school day - Ang & Cel', '2026-11-27T08:00', '2026-11-27T15:00', UWC),
    ev('wait', 'UWC at school until tennis - Cel', '2026-11-27T15:00', '2026-11-27T16:30', UWC),
    ev('violin', 'UWC Violin - Ang TBC', '2026-11-27T15:00', '2026-11-27T16:30', UWC),
    ev('tennis', 'UWC Tennis - Cel', '2026-11-27T16:30', '2026-11-27T18:00', UWC),
  ];
  const who = new Map(day.map((e) => [e.id, parseWho(e.summary, ctx).childIds]));
  const st = stays(day, 15, (e) => who.get(e.id));
  assert.deepEqual(st.get('violin'), { drop: false, pick: true, after: 'UWC school day - Ang & Cel' }, 'Ang must be picked up after violin');
  assert.deepEqual(st.get('wait'), { drop: false, pick: false, after: 'UWC school day - Ang & Cel' });
  assert.deepEqual(st.get('tennis'), { drop: false, pick: true, after: 'UWC at school until tennis - Cel' });
  assert.equal(st.get('school').pick, false);
});

test('two children to the same place at the same time share the car: no clash', () => {
  const S = { drop_buffer_min: 10, pick_buffer_min: 5 };
  const trip = (id, start, end, loc) => {
    const l = leaveTimes(`${start}+08:00`, `${end}+08:00`, 15, S);
    return { id, event_start: `${start}+08:00`, event_end: `${end}+08:00`, drive_min: 15, location: loc, status: 'open',
      drop_leave_at: l.dropLeave.toISOString(), pick_leave_at: l.pickLeave.toISOString() };
  };
  const a = trip('a', '2026-11-28T09:00:00', '2026-11-28T10:00:00', '649852');
  const b = trip('b', '2026-11-28T09:10:00', '2026-11-28T10:05:00', 'Jurong West pool 649852');
  assert.deepEqual(findClashes([a, b], 1), [], 'same pool: one car does both');
  const c = trip('c', '2026-11-28T09:10:00', '2026-11-28T10:05:00', '258130');
  assert.equal(findClashes([a, c], 1).length, 1, 'another place: still a clash');
  assert.deepEqual(findClashes([{ ...a, who_state: 'unknown' }, c], 1), [], 'an event not yet known to be a child\'s is not planned');
});

const SET = { home_postal: '098652', home_lat: 1.27, home_lng: 103.82, cars: 1, plan_time: '19:00:00', quiet_start: '22:00:00',
  quiet_end: '07:00:00', evening_slot: '21:30:00', drop_buffer_min: 10, pick_buffer_min: 5, scan_minutes: 15, last_scan_at: null,
  paused_at: null, max_messages_day: 30 };
const MODES = { car: { route: 'drive', estimate_min: 30, lead_min: 0 }, taxi: { route: 'drive', estimate_min: 30, lead_min: 10 },
  public: { route: 'pt', estimate_min: 60, lead_min: 0 } };
const onemap = { find: async () => ({ lat: 1.31, lng: 103.77 }), routeMinutes: async () => 18 };

test("scan: adults' events are not trips, an unknown name is asked once, the answer makes it a child's trip", async () => {
  const db = fakeTripsDb({ settings: { ...SET }, adults: [JOHN, MEI], modes: MODES, children: KIDS.map((k) => ({ ...k, aliases: [...k.aliases] })), convention: CONV });
  let now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const events = [
    ev('dentist', 'Dentist', '2026-11-28T10:00', '2026-11-28T11:00', '238884'),
    ev('meet', 'Board meeting - John', '2026-11-28T13:00', '2026-11-28T14:00', '049483'),
    ev('art', 'Art - Cece', '2026-11-28T14:00', '2026-11-28T15:00', '239809'),
    ev('art2', 'Clay - Cece', '2026-11-28T16:00', '2026-11-28T17:00', '239809'),
    ev('af', 'AF - Ang', '2026-11-28T09:30', '2026-11-28T11:30', '258130'),
  ];
  const deps = { job: db.job, google: { list: async () => events }, onemap };
  const r = await tickFamily(await db.job.load(), deps, now);
  assert.deepEqual(db.trips.map((t) => t.event_id).sort(), ['af', 'art', 'art2'], "the adults' events are not trips");
  const unknown = r.outbox.filter((m) => m.kind === 'unknown');
  assert.deepEqual(unknown.map((m) => m.chat).sort(), [111, 222], '"Cece" asked once per adult, for both events');
  assert.match(unknown[0].reply.text, /Who is "Cece" in "Art - Cece"/);
  assert.deepEqual(unknown[0].reply.buttons[0].map((b) => b.label), ["It's Angela", "It's Celine"]);
  assert.equal(r.outbox.filter((m) => m.kind === 'plan' && /Art|Clay/.test(m.reply.text)).length, 0, 'not planned while unknown');
  assert.equal(r.outbox.filter((m) => m.kind === 'plan' && /AF - Ang/.test(m.reply.text)).length, 2);
  // Mei answers: Cece is Celine. The name becomes Celine's nickname; both events become Celine's.
  const cel = unknown[0].reply.buttons[0][1].action;
  const [reply] = await handleTripButton(cel, { person_id: MEI.person_id }, db.botStore(MEI.person_id), { timeZone: TZ });
  assert.match(reply.text, /nickname of Celine/);
  assert.ok(db.children.find((c) => c.id === CEL.id).aliases.includes('Cece'));
  now = at('2026-11-28T08:01:00');
  await tickFamily(await db.job.load(), deps, now);
  assert.deepEqual(db.trips.filter((t) => /art/.test(t.event_id)).map((t) => [t.who_state, t.child_ids]), [['child', [CEL.id]], ['child', [CEL.id]]]);
  // "Not a child" on an unknown name: the event stays out of the plan.
  events.push(ev('x', 'Drinks - Bobby', '2026-11-28T20:00', '2026-11-28T21:00', '049483'));
  db.settings.last_scan_at = null;
  now = at('2026-11-28T08:02:00');
  const r3 = await tickFamily(await db.job.load(), deps, now);
  const q = r3.outbox.find((m) => m.kind === 'unknown' && m.chat === 111);
  const not = q.reply.buttons.at(-1)[0].action;
  const [r4] = await handleTripButton(not, { person_id: JOHN.person_id }, db.botStore(JOHN.person_id), { timeZone: TZ });
  assert.match(r4.text, /adult's own event/);
  db.settings.last_scan_at = null;
  now = at('2026-11-28T08:03:00');
  const r5 = await tickFamily(await db.job.load(), deps, now);
  assert.equal(db.trips.find((t) => t.event_id === 'x').who_state, 'none_by_adult');
  assert.equal(r5.outbox.filter((m) => /Drinks/.test(m.reply.text)).length, 0, 'never asked or planned again');
});

test('one child in two places at once: flagged once to each adult as a likely calendar mistake', async () => {
  const db = fakeTripsDb({ settings: { ...SET }, adults: [JOHN, MEI], modes: MODES, children: KIDS, convention: CONV });
  const now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const events = [ev('jazz', 'Jazz @ Princep - Ang', '2026-11-29T09:00', '2026-11-29T10:30', '188648'),
    ev('art', 'Art - Ang', '2026-11-29T10:00', '2026-11-29T13:00', '239809')];
  const deps = { job: db.job, google: { list: async () => events }, onemap };
  const r1 = await tickFamily(await db.job.load(), deps, now);
  db.settings.last_scan_at = null;
  const r2 = await tickFamily(await db.job.load(), deps, at('2026-11-28T08:01:00'));
  const doubles = [...r1.outbox, ...r2.outbox].filter((m) => m.kind === 'double');
  assert.deepEqual(doubles.map((m) => m.chat).sort(), [111, 222]);
  assert.match(doubles[0].reply.text, /same child in two places at once:\n- Jazz @ Princep - Ang, Sun 29 Nov, 09:00-10:30 at 188648\n- Art - Ang, Sun 29 Nov, 10:00-13:00 at 239809/);
});

test('/children in the bot: list, add, remove; data notice v2 asks every adult to agree again', async () => {
  const db = fakeDb(); db.addFamily('Tan family', '0123456789abcdef0123456789abcdef');
  const cfg1 = { noticeVersion: 'v1', noticeUrl: 'x', inviteHours: 48, botUsername: 'B' };
  let u = 0;
  const say = (text, cfg) => handle(parseUpdate({ update_id: ++u, message: { from: { id: 100 }, chat: { id: 100, type: 'private' }, text } }), db.storeFor(), cfg, null);
  await handle(parseUpdate({ update_id: ++u, callback_query: { id: 'q', from: { id: 100 }, data: 'agree:0123456789abcdef0123456789abcdef', message: { chat: { id: 100, type: 'private' } } } }), db.storeFor(), cfg1, null);
  const [empty] = await say('/children', cfg1);
  assert.match(empty.text, /No children listed yet/);
  const [added] = await say('/children add Celine = Cel, Ce-Ce', cfg1);
  assert.match(added.text, /Done\. Children:\n- Celine \(also: Cel, Ce-Ce\)/);
  const [bad] = await say('/children add Ang = 987654321', cfg1);
  assert.match(bad.text, /cannot use "987654321" as a name/);
  const [gone] = await say('/children remove Celine', cfg1);
  assert.match(gone.text, /No children listed yet/);
  // The notice moves to v2: the next message shows the new notice first.
  const cfg2 = { ...cfg1, noticeVersion: 'v2' };
  const [notice] = await say('/children', cfg2);
  assert.match(notice.text, /Our data notice has changed/);
  assert.match(notice.text, /children's names and nicknames/);
});

test('plan round: an unknown or adult-marked trip is never asked "who takes it?"', async () => {
  const db = fakeTripsDb({ settings: { ...SET }, adults: [JOHN], modes: MODES, children: KIDS, convention: CONV });
  const now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const deps = { job: db.job, google: { list: async () => [ev('p', 'Party - Bobby', '2026-11-28T15:00', '2026-11-28T17:00', '049483')] }, onemap };
  const r = await tickFamily(await db.job.load(), deps, now);
  assert.deepEqual(r.outbox.map((m) => m.kind), ['unknown']);
  assert.equal(localParts(TZ, now).date, '2026-11-28');
});
