// prj02-R1 US-3 (reminders and clashes). Unit tests of the trip arithmetic, then the 10-event test
// week replayed minute by minute with a simulated clock (Fri 27 Nov 18:00 to Mon 30 Nov 00:30 SGT):
// two adults, one car, a 06:30 activity, a one-car clash, an event with no location, one abroad,
// an all-day and a cancelled event (noise), one event moved and one deleted mid-week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveTimes, inQuiet, sendTime, findClashes, clashOptions, isActivity, placeKey } from '../lib/trips/plan.js';
import { tickFamily } from '../lib/trips/tick.js';
import { handleTripButton } from '../lib/bot/trips.js';
import { localParts } from '../lib/calendar/dates.js';
import { fakeTripsDb } from './fake-trips.js';

const TZ = 'Asia/Singapore';
const S = { home_postal: '640123', home_lat: null, home_lng: null, cars: 1, plan_time: '19:00:00', quiet_start: '22:00:00',
  quiet_end: '07:00:00', evening_slot: '21:30:00', drop_buffer_min: 10, pick_buffer_min: 5, scan_minutes: 15, last_scan_at: null };
// The family's ways of travel (app_prj02.travel_modes). The estimates here are test data; John's
// family has car 30, taxi 30 + 10, public transport 60 (Hub row 277).
const MODES = { car: { route: 'drive', estimate_min: 20, lead_min: 0 }, taxi: { route: 'drive', estimate_min: 20, lead_min: 10 },
  public: { route: 'pt', estimate_min: 45, lead_min: 0 } };
const at = (s) => new Date(`${s}+08:00`);
const local = (d) => { const p = localParts(TZ, d); return `${p.date} ${p.time}`; };

test('leave times follow the agent card: drop = start - drive - 10, pick = end - drive - 5', () => {
  const l = leaveTimes('2026-11-28T15:00:00+08:00', '2026-11-28T16:00:00+08:00', 18, S);
  assert.equal(local(l.dropLeave), '2026-11-28 14:32');
  assert.equal(local(l.pickLeave), '2026-11-28 15:37');
});

test('quiet hours 22:00-07:00: due messages move to 21:30 the evening before', () => {
  assert.equal(inQuiet(at('2026-11-28T06:02:00'), S, TZ), true);
  assert.equal(inQuiet(at('2026-11-27T21:59:00'), S, TZ), false);
  assert.equal(inQuiet(at('2026-11-27T22:00:00'), S, TZ), true);
  assert.equal(inQuiet(at('2026-11-28T07:00:00'), S, TZ), false);
  assert.equal(local(sendTime(at('2026-11-28T06:02:00'), S, TZ)), '2026-11-27 21:30', 'early morning: the evening before');
  assert.equal(local(sendTime(at('2026-11-29T22:07:00'), S, TZ)), '2026-11-29 21:30', 'late evening: the same evening');
  assert.equal(local(sendTime(at('2026-11-28T14:32:00'), S, TZ)), '2026-11-28 14:32');
});

test('clashes: one car needed twice at once; none with 2 cars, with taxis, or when both are agreed', () => {
  const trip = (id, start, end, drive, extra = {}) => {
    const l = leaveTimes(`${start}+08:00`, `${end}+08:00`, drive, S);
    return { id, event_start: `${start}+08:00`, event_end: `${end}+08:00`, drive_min: drive, status: 'open',
      drop_leave_at: l.dropLeave.toISOString(), pick_leave_at: l.pickLeave.toISOString(), ...extra };
  };
  const a = trip('a', '2026-11-28T09:00:00', '2026-11-28T10:00:00', 12);
  const b = trip('b', '2026-11-28T09:15:00', '2026-11-28T10:15:00', 15);
  const c = trip('c', '2026-11-28T14:00:00', '2026-11-28T15:00:00', 20);
  assert.deepEqual(findClashes([a, b, c], 1).map((p) => p.map((t) => t.id)), [['a', 'b']]);
  assert.deepEqual(findClashes([a, b], 2), []);
  assert.deepEqual(findClashes([a, { ...b, owner_mode: 'taxi' }], 1), []);
  assert.deepEqual(findClashes([{ ...a, status: 'assigned' }, { ...b, status: 'assigned' }], 1), []);
  // Back-to-back: the drive back with the first child ends before the second leave time.
  const d = trip('d', '2026-11-28T11:00:00', '2026-11-28T11:30:00', 10);
  const e = trip('e', '2026-11-28T12:30:00', '2026-11-28T13:00:00', 10);
  assert.deepEqual(findClashes([d, e], 1), []);
  const [o1, o2] = clashOptions([a, b], { person_id: 'p-john' });
  assert.deepEqual(o1, [{ trip: 'a', mode: 'adult', person: 'p-john' }, { trip: 'b', mode: 'taxi' }]);
  assert.deepEqual(o2, [{ trip: 'b', mode: 'adult', person: 'p-john' }, { trip: 'a', mode: 'taxi' }]);
});

test('activities: timed and not cancelled; place keys ignore case and spaces', () => {
  assert.equal(isActivity({ start: { date: '2026-11-28' }, end: { date: '2026-11-29' } }), false);
  assert.equal(isActivity({ status: 'cancelled', start: { dateTime: 'x' }, end: { dateTime: 'y' } }), false);
  assert.equal(isActivity({ summary: '🚗 Daily plan', start: { dateTime: 'x' }, end: { dateTime: 'y' } }), false);
  assert.equal(isActivity({ summary: 'Swim', start: { dateTime: 'x' }, end: { dateTime: 'y' } }), true);
  assert.equal(placeKey('  Jurong West   Swimming Complex '), 'jurong west swimming complex');
});

// ---------- the 10-event test week ----------

const JOHN = { person_id: '11111111-aaaa-4000-8000-000000000001', display_name: 'John L', can_drive: true, chat: 111 };
const MEI = { person_id: '22222222-bbbb-4000-8000-000000000002', display_name: 'Mei Tan', can_drive: false, chat: 222 };
const ev = (id, title, start, end, location) => ({ id, summary: `[TEST] ${title}`, status: 'confirmed', location,
  start: { dateTime: `${start}:00+08:00` }, end: { dateTime: `${end}:00+08:00` } });

function weekEvents() {
  return [
    ev('e1', 'Mei tuition', '2026-11-27T20:00', '2026-11-27T21:00', 'Bishan Library'),
    ev('e2', 'Ethan swim training', '2026-11-28T06:30', '2026-11-28T08:00', 'Jurong West Swimming Complex'),
    ev('e3', 'Mei ballet', '2026-11-28T09:00', '2026-11-28T10:00', 'Bishan'),
    ev('e4', 'Ethan football', '2026-11-28T09:15', '2026-11-28T10:15', 'Toa Payoh Stadium'),
    ev('e5', 'Ethan piano', '2026-11-28T14:00', '2026-11-28T15:00', undefined),
    ev('e6', "Dinner at Grandma's", '2026-11-28T18:00', '2026-11-28T19:30', 'Kuala Lumpur'),
    ev('e7', 'Mei swim', '2026-11-29T10:00', '2026-11-29T11:00', 'jurong west  swimming complex'),
    ev('e8', 'Ethan tuition', '2026-11-29T13:00', '2026-11-29T14:00', 'Bishan Library'),
    ev('e9', 'Mei art class', '2026-11-29T16:00', '2026-11-29T17:00', 'Toa Payoh'),
    ev('e10', 'Movie night', '2026-11-29T21:45', '2026-11-29T22:40', 'Bishan'),
    // Noise: an all-day event and a cancelled one.
    { id: 'n1', summary: "[TEST] Grandma's birthday", start: { date: '2026-11-29' }, end: { date: '2026-11-30' } },
    { ...ev('n2', 'Cancelled class', '2026-11-28T11:00', '2026-11-28T12:00', 'Bishan'), status: 'cancelled' },
  ];
}

function fakeOneMap() {
  const where = { '640123': [1.35, 103.70], 'bishan library': [1.35, 103.85], 'jurong west swimming complex': [1.34, 103.69],
    'toa payoh stadium': [1.33, 103.85], 'toa payoh': [1.33, 103.84], bishan: [1.35, 103.84] };
  const minutes = { '1.35,103.85': 12, '1.34,103.69': 25, '1.33,103.85': 15, '1.33,103.84': 14, '1.35,103.84': 12 };
  const calls = { find: 0, drive: 0, pt: 0 };
  return {
    calls,
    find: async (q) => { calls.find++; const p = where[placeKey(q)]; return p ? { lat: p[0], lng: p[1] } : null; },
    // Public transport takes twice the drive time plus 5 minutes in this fake.
    routeMinutes: async (_from, to, route) => {
      calls[route] = (calls[route] ?? 0) + 1;
      const d = minutes[`${to.lat},${to.lng}`] ?? 30;
      return route === 'pt' ? d * 2 + 5 : d;
    },
  };
}

async function replayWeek() {
  let now = at('2026-11-27T18:00:00');
  const db = fakeTripsDb({ settings: S, adults: [JOHN, MEI], modes: MODES });
  db.setClock(() => now.getTime());
  let events = weekEvents();
  const onemap = fakeOneMap();
  const google = { list: async (_c, from, to) => events.filter((e) => {
    const s = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00+08:00`);
    const end = Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00+08:00`);
    return end > Date.parse(from) && s < Date.parse(to);
  }) };
  const sent = [];
  const choice = (title) => (title.includes('piano') ? 'taxi' : 'john');
  const end = at('2026-11-30T00:30:00').getTime();
  while (now.getTime() <= end) {
    if (local(now) === '2026-11-28 08:00') { // Ethan tuition moves from 13:00 to 15:00
      events = events.map((e) => (e.id === 'e8' ? { ...e, start: { dateTime: '2026-11-29T15:00:00+08:00' }, end: { dateTime: '2026-11-29T16:00:00+08:00' } } : e));
    }
    if (local(now) === '2026-11-28 12:00') events = events.filter((e) => e.id !== 'e9'); // art class deleted
    const r = await tickFamily(await db.job.load(), { job: db.job, google, onemap }, now);
    for (const m of r.outbox) {
      sent.push({ at: local(now), chat: m.chat, kind: m.kind, text: m.reply.text, buttons: m.reply.buttons });
      // John answers each question as soon as it arrives (Mei gets it too, John taps first).
      if (m.chat === JOHN.chat && (m.kind === 'plan' || m.kind === 'clash')) {
        const buttons = m.reply.buttons.flat();
        // Release-1 answers (John drives there and back, or the whole trip by taxi) as 'tr:' taps, so the
        // week keeps its standard leave times; the ways of US-9 are tested in test/ways.test.js.
        const trip = db.reminders.find((x) => x.id === m.id)?.trip_id;
        const action = m.kind === 'clash' ? buttons[0].action
          : choice(m.reply.text) === 'taxi' ? `tr:${trip}:taxi` : `tr:${trip}:${JOHN.person_id.slice(0, 8)}`;
        const [reply] = await handleTripButton(action, { person_id: JOHN.person_id }, db.botStore(JOHN.person_id), { timeZone: TZ });
        sent.push({ at: local(now), chat: JOHN.chat, kind: 'tap-reply', text: reply.text });
      }
    }
    now = new Date(now.getTime() + 60_000);
  }
  return { db, sent, onemap };
}

test('test week: every reminder reaches the right adult on time, outside quiet hours, once', async () => {
  const { db, sent, onemap } = await replayWeek();
  const bot = sent.filter((m) => m.kind !== 'tap-reply');
  // Nothing in quiet hours.
  for (const m of bot) {
    const t = m.at.slice(11);
    assert.ok(!(t >= '22:00' || t < '07:00'), `message in quiet hours: ${m.at} ${m.kind}`);
  }
  // No duplicates: one message per (chat, kind, text).
  const keys = bot.map((m) => `${m.chat}|${m.kind}|${m.text}`);
  assert.equal(new Set(keys).size, keys.length, 'a message was sent twice');

  const rem = (title, kind) => bot.filter((m) => m.kind === kind && m.text.includes(title));
  // e1 (today, after the plan time already): asked at 18:00, reminders at leave times 19:38 / 20:43.
  assert.equal(rem('Mei tuition', 'plan')[0].at, '2026-11-27 18:00');
  assert.deepEqual(rem('Mei tuition', 'drop').map((m) => [m.at, m.chat]), [['2026-11-27 19:38', 111]]);
  assert.deepEqual(rem('Mei tuition', 'pick').map((m) => [m.at, m.chat]), [['2026-11-27 20:43', 111]]);
  // e2 at 06:30: asked at 19:00 the evening before; drop-off reminder (05:55, quiet) comes at 21:30.
  assert.equal(rem('Ethan swim training', 'plan')[0].at, '2026-11-27 19:00');
  const e2 = rem('Ethan swim training', 'drop');
  assert.deepEqual(e2.map((m) => m.at), ['2026-11-27 21:30']);
  assert.match(e2[0].text, /For tomorrow morning .*leave at 05:55.*drive about 25 min/si);
  assert.deepEqual(rem('Ethan swim training', 'pick').map((m) => m.at), ['2026-11-28 07:30']);
  // e3 + e4 clash on the one car: a clash message with 2 options to both adults, no plan message.
  const clash = bot.filter((m) => m.kind === 'clash');
  assert.deepEqual(clash.map((m) => m.chat).sort(), [111, 222]);
  assert.match(clash[0].text, /Clash on Sat 28 Nov.*Mei ballet 09:00-10:00 \(leave 08:38 for drop-off, 09:43 for pick-up\).*Ethan football 09:15-10:15 \(leave 08:50 for drop-off.*Option 1: John drives \[TEST\] Mei ballet; \[TEST\] Ethan football by taxi.*My own plan/s);
  assert.deepEqual(clash[0].buttons.slice(1).flat().map((b) => b.label), ['Other ways…', 'My own plan…']);
  assert.equal(rem('Mei ballet', 'plan').length + rem('Ethan football', 'plan').length, 0);
  // Option 1 tapped: John drives ballet (drive 12, leave 08:38); football by taxi, reminder to John
  // 10 min earlier than the car leave time (taxi booking lead, Hub row 277).
  assert.deepEqual(rem('Mei ballet', 'drop').map((m) => [m.at, m.chat]), [['2026-11-28 08:38', 111]]);
  const taxi = rem('Ethan football', 'drop');
  assert.deepEqual(taxi.map((m) => [m.at, m.chat]), [['2026-11-28 08:40', 111]]);
  assert.match(taxi[0].text, /^Book the taxi now/);
  // e5 has no location: the car estimate (20 min, 'est.') in the question; taxi chosen, so the
  // taxi estimate plus its booking lead (20 + 10): 10 min earlier.
  assert.match(rem('Ethan piano', 'plan')[0].text, /drive about 20 min \(est\.\)/i);
  assert.deepEqual(rem('Ethan piano', 'drop').map((m) => m.at), ['2026-11-28 13:20']);
  // e6 abroad: OneMap finds nothing in Singapore, so the estimate.
  assert.match(rem("Dinner at Grandma's", 'plan')[0].text, /\(est\.\)/);
  // e7 reuses the saved place (spelled differently): 25 min, from OneMap.
  assert.deepEqual(rem('Mei swim', 'drop').map((m) => m.at), ['2026-11-29 09:25']);
  // e8 moved from 13:00 to 15:00 before its plan round: reminders at the new leave times.
  assert.deepEqual(rem('Ethan tuition', 'drop').map((m) => m.at), ['2026-11-29 14:38']);
  // e9 deleted on Sat 12:00: asked on Sat 19:00? No: it was gone by then, so nothing at all.
  assert.equal(bot.filter((m) => m.text.includes('Mei art class')).length, 0);
  // e10 ends 22:40: pick-up leave 22:23 is in quiet hours, so it comes at 21:30 the same evening.
  assert.deepEqual(rem('Movie night', 'pick').map((m) => m.at), ['2026-11-29 21:30']);
  // Noise ignored.
  assert.equal(bot.filter((m) => /birthday|Cancelled class/.test(m.text)).length, 0);
  // Every assigned trip that still exists got exactly one drop and one pick reminder.
  for (const t of db.trips.filter((x) => x.status === 'assigned')) {
    for (const kind of ['drop', 'pick']) {
      const n = db.reminders.filter((r) => r.trip_id === t.id && r.kind === kind && r.status === 'sent').length;
      assert.equal(n, 1, `${t.title} ${kind}: ${n} sent`);
    }
  }
  assert.equal(db.trips.filter((x) => x.status === 'assigned').length, 9);
  // OneMap: home once, then each distinct place once (saved places reused).
  assert.equal(onemap.calls.drive, 6, "5 distinct Singapore places (Toa Payoh scanned before e9 was deleted) + 1 drive between the clash's two places (US-8, saved once)");
});

test('a tap answers with who takes it and the leave times; foreign or stale buttons change nothing', async () => {
  const db = fakeTripsDb({ settings: S, adults: [JOHN, MEI], modes: MODES });
  const now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const id = await db.job.upsertTrip({ event_id: 'x', start: at('2026-11-28T15:00:00'), end: at('2026-11-28T16:00:00'),
    title: 'Ethan swim', location: 'Jurong West', drive_min: 18, drive_source: 'onemap',
    drop_leave: at('2026-11-28T14:32:00'), pick_leave: at('2026-11-28T15:37:00'),
    drop_send: at('2026-11-28T14:32:00'), pick_send: at('2026-11-28T15:37:00') });
  const store = db.botStore(MEI.person_id);
  const [r] = await handleTripButton(`tr:${id}:${JOHN.person_id.slice(0, 8)}`, {}, store, { timeZone: TZ });
  assert.match(r.text, /Done: Ethan swim \(Sat 28 Nov, 15:00-16:00\): John L takes it\. Reminders: leave 14:32 for drop-off, 15:37 for pick-up\./);
  assert.equal(db.reminders.filter((x) => x.person_id === JOHN.person_id).length, 2, 'reminders go to the owner, not the tapper');
  assert.match((await handleTripButton(`tr:${id}:deadbeef`, {}, store, {}))[0].text, /not possible/);
  assert.match((await handleTripButton('tr:00000000-0000-4000-8000-999999999999:taxi', {}, store, {}))[0].text, /no longer in the plan/);
  assert.match((await handleTripButton('cl:00000000-0000-4000-8000-999999999999:1', {}, store, {}))[0].text, /no longer in the plan/);
  assert.match((await handleTripButton('tr:garbage', {}, store, {}))[0].text, /no longer in the plan/);
});
