// prj02-R1 US-8: real clash days (decision Hub row 298, gap Hub row 296). One adult and one car do
// both activities in a row (design fix 1, Hub row 106), an adult's own leave time, different adults
// per leg. First test case: John's real Saturday 28/11 - Ballet @ River (Cel, 15:30-17:30, 9 min
// from home) and Acro @ Dunearn (Ang, 15:30-17:00, 22 min) - and his plan "drop Cel at River, then
// Ang at Dunearn, leave 14:45, wait at Acro, pick Ang at 17:00, then Cel at 17:30".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainPlan, chainSummary } from '../lib/trips/chain.js';
import { tickFamily } from '../lib/trips/tick.js';
import { handleTripButton } from '../lib/bot/trips.js';
import { checkPlan, buildProposal, handlePlanText } from '../lib/bot/plan.js';
import { localParts } from '../lib/calendar/dates.js';
import { fakeTripsDb } from './fake-trips.js';

const TZ = 'Asia/Singapore';
const at = (s) => new Date(`${s}+08:00`);
const hm = (d) => localParts(TZ, new Date(d)).time;
const S = { home_postal: '098652', home_lat: 1.27, home_lng: 103.82, cars: 1, plan_time: '19:00:00', quiet_start: '22:00:00',
  quiet_end: '07:00:00', evening_slot: '21:30:00', drop_buffer_min: 10, pick_buffer_min: 5, scan_minutes: 15, last_scan_at: null,
  paused_at: null, max_messages_day: 30 };
const MODES = { car: { route: 'drive', estimate_min: 30, lead_min: 0 }, taxi: { route: 'drive', estimate_min: 30, lead_min: 10 },
  public: { route: 'pt', estimate_min: 60, lead_min: 0 } };
const JOHN = { person_id: 'bbbbbbbb-0000-4000-8000-000000000001', display_name: 'John L', can_drive: true, chat: 111 };
const MEI = { person_id: 'dddddddd-0000-4000-8000-000000000002', display_name: 'Mei', can_drive: true, chat: 222 };
const ANG = { id: 'aaaa1111-0000-4000-8000-000000000001', name: 'Angela', aliases: ['Ang'] };
const CEL = { id: 'cccc2222-0000-4000-8000-000000000002', name: 'Celine', aliases: ['Cel'] };
const ADULTS = [{ id: JOHN.person_id, display_name: 'John L' }, { id: MEI.person_id, display_name: 'Mei' }];

const ballet = { id: 'tb', title: 'Ballet @ River - Cel', event_start: '2026-11-28T15:30:00+08:00', event_end: '2026-11-28T17:30:00+08:00', drive_min: 9, location: '248371' };
const acro = { id: 'ta', title: 'Acro @ Dunearn - Ang', event_start: '2026-11-28T15:30:00+08:00', event_end: '2026-11-28T17:00:00+08:00', drive_min: 22, location: '589472' };

test('chained trip on John\'s Saturday: both drop-offs in a row, wait at Acro, pick-ups in a row', () => {
  const c = chainPlan([ballet, acro], S, 15);
  assert.equal(chainSummary(c, hm), 'leave 14:54: Ballet @ River 15:03, then Acro @ Dunearn 15:20; wait there; pick up Acro @ Dunearn 17:00, then Ballet @ River 17:17; home ~17:41');
  const l = (id) => Object.fromEntries(Object.entries(c.legs.get(id)).map(([k, v]) => [k, v instanceof Date ? hm(v) : v]));
  assert.deepEqual(l('tb'), { drop_leave: '14:54', drop_note: 'then Acro @ Dunearn - Ang', pick_leave: '17:02', pick_note: 'after Acro @ Dunearn - Ang' });
  assert.deepEqual(l('ta'), { drop_leave: '15:05', drop_note: 'after Ballet @ River - Cel', pick_leave: '16:55', pick_note: 'you wait there' });
  // John's own leave time 14:45 works; 15:10 is too late for Acro at 15:30.
  assert.equal(hm(chainPlan([ballet, acro], S, 15, { leave: at('2026-11-28T14:45:00') }).atY), '15:11');
  assert.equal(chainPlan([ballet, acro], S, 15, { leave: at('2026-11-28T15:10:00') }), null);
  // Places too far apart for the times: no chained option at all.
  assert.equal(chainPlan([ballet, acro], S, 60), null);
});

const ev = (id, title, s, e, loc) => ({ id, summary: title, location: loc, start: { dateTime: `${s}:00+08:00` }, end: { dateTime: `${e}:00+08:00` } });
const minutes = { '1.29,103.84': 9, '1.33,103.81': 22 };
const onemap = {
  calls: 0,
  find: async (q) => (q.includes('248371') ? { lat: 1.29, lng: 103.84 } : q.includes('589472') ? { lat: 1.33, lng: 103.81 } : { lat: 1.3, lng: 103.8 }),
  async routeMinutes(from, to) { this.calls++; const k = `${to.lat},${to.lng}`; if (from.lat === 1.27) return minutes[k] ?? 18; return 15; },
};

test('clash message: option 3 (John does both in a row), tapped: reminders per leg at the chained times', async () => {
  const db = fakeTripsDb({ settings: { ...S }, adults: [JOHN, MEI], modes: MODES, children: [ANG, CEL] });
  let now = at('2026-11-27T19:05:00');
  db.setClock(() => now.getTime());
  const events = [ev('ballet', 'Ballet @ River - Cel', '2026-11-28T15:30', '2026-11-28T17:30', '248371, Singapore 248371'),
    ev('acro', 'Acro @ Dunearn - Ang', '2026-11-28T15:30', '2026-11-28T17:00', '589472, Singapore 589472')];
  const deps = { job: db.job, google: { list: async () => events }, onemap };
  const r = await tickFamily(await db.job.load(), deps, now);
  const clash = r.outbox.find((m) => m.kind === 'clash' && m.chat === 111);
  assert.match(clash.reply.text, /Option 3: John does both: leave 14:54: Ballet @ River 15:03, then Acro @ Dunearn 15:20; wait there; pick up Acro @ Dunearn 17:00, then Ballet @ River 17:17; home ~17:41\./);
  assert.deepEqual(clash.reply.buttons[0].map((b) => b.label), ['Option 1', 'Option 2', 'Option 3']);
  const [done] = await handleTripButton(clash.reply.buttons[0][2].action, { person_id: JOHN.person_id }, db.botStore(JOHN.person_id), { timeZone: TZ });
  assert.match(done.text, /^Chosen by John at \d\d:\d\d:\nDone/);
  assert.equal(done.edit, true, 'the clash message is replaced: no options left to tap');
  assert.deepEqual(done.buttons.flat().map((b) => b.label), ['My own plan…']);
  const due = db.reminders.filter((m) => m.status === 'due' && ['drop', 'pick'].includes(m.kind))
    .map((m) => [db.trips.find((t) => t.id === m.trip_id).event_id, m.kind, m.person_id === JOHN.person_id ? 'John' : 'other', hm(m.send_at)])
    .sort((a, b) => a[3].localeCompare(b[3]));
  assert.deepEqual(due, [['ballet', 'drop', 'John', '14:54'], ['acro', 'drop', 'John', '15:05'], ['acro', 'pick', 'John', '16:55'], ['ballet', 'pick', 'John', '17:02']]);
  // The next scan keeps the chained times; the reminders read as a chain.
  db.settings.last_scan_at = null;
  now = at('2026-11-28T14:54:00');
  const r2 = await tickFamily(await db.job.load(), deps, now);
  const first = r2.outbox.find((m) => m.kind === 'drop');
  assert.match(first.reply.text, /^Time to leave: drop-off for Ballet @ River - Cel, Sat 28 Nov, 15:30-17:30 at 248371 \(then Acro @ Dunearn - Ang\)\./);
  now = at('2026-11-28T16:55:00');
  const r3 = await tickFamily(await db.job.load(), deps, now);
  assert.match(r3.outbox.find((m) => m.kind === 'pick').reply.text, /^Pick-up at 17:00 \(you are there\): Acro @ Dunearn - Ang/);
});

test("own plan in John's words: chained with his leave time, shown first, applied only by his yes", async () => {
  const db = fakeTripsDb({ settings: { ...S }, adults: [JOHN, MEI], modes: MODES, children: [ANG, CEL] });
  const now = at('2026-11-27T19:05:00');
  db.setClock(() => now.getTime());
  const events = [ev('ballet', 'Ballet @ River - Cel', '2026-11-28T15:30', '2026-11-28T17:30', '248371'),
    ev('acro', 'Acro @ Dunearn - Ang', '2026-11-28T15:30', '2026-11-28T17:00', '589472')];
  const deps = { job: db.job, google: { list: async () => events }, onemap };
  const r = await tickFamily(await db.job.load(), deps, now);
  const clash = r.outbox.find((m) => m.kind === 'clash' && m.chat === 111);
  const john = db.botStore(JOHN.person_id);
  await handleTripButton(clash.reply.buttons.flat().find((b) => b.label === 'My own plan…').action, { person_id: JOHN.person_id }, john, { timeZone: TZ, planValidMinutes: 30 });
  const pending = await john.planPending();
  assert.equal(pending.between_min, 15, 'the drive between the two places comes with the clash');
  const n = (title) => pending.trips.map((id) => db.trips.find((t) => t.id === id).title).indexOf(title) + 1;
  const form = { intent: 'plan', trips: [{ n: n('Ballet @ River - Cel'), who: 'me', leave_time: '14:45' }, { n: n('Acro @ Dunearn - Ang'), who: 'me' }] };
  const [shown] = await handlePlanText({ text: 'I drop off Cel, leave house at 1445, same departure for Acro, wait at Acro' },
    { person_id: JOHN.person_id, family_id: 'fam-1' }, john, { interpretPlan: async () => form }, {}, pending);
  assert.match(shown.text, /Ballet @ River - Cel, Sat 28 Nov, 15:30-17:30: drop-off by John \(leave 14:45, then Acro @ Dunearn - Ang\); pick-up by John \(leave 17:02, after Acro @ Dunearn - Ang\)\./);
  assert.match(shown.text, /Acro @ Dunearn - Ang, Sat 28 Nov, 15:30-17:00: drop-off by John \(leave 14:56, after Ballet @ River - Cel\); pick-up by John \(waiting there\)\./);
  await handleTripButton(shown.buttons[0][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  const due = db.reminders.filter((m) => m.status === 'due' && ['drop', 'pick'].includes(m.kind)).map((m) => [m.kind, hm(m.send_at)]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(due, [['drop', '14:45'], ['drop', '14:56'], ['pick', '16:55'], ['pick', '17:02']]);
});

test('own plan: different adults per leg, a leg by taxi, and a leave time that is too late', () => {
  const trips = [ballet, acro];
  const items = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'taxi' }, { n: 2, who: 'me', pick_who: 'Mei' }] }, { trips, adults: ADULTS, askerId: JOHN.person_id }).items;
  const b = buildProposal(items, S, TZ, ADULTS, { betweenMin: 15 });
  assert.equal(b.ask, undefined, b.ask);
  const acroItem = b.proposal.find((p) => p.trip === 'ta');
  assert.deepEqual([acroItem.mode, acroItem.person, acroItem.pick_person], ['adult', JOHN.person_id, MEI.person_id]);
  assert.match(b.lines[1], /drop-off by John \(leave 14:58\); pick-up by Mei \(leave 16:33\)/);
  // "I drop Ang, Cel takes the bus home" -> pick leg by public transport.
  const bus = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', pick_who: 'bus' }, { n: 2, who: 'taxi' }] }, { trips, adults: ADULTS, askerId: JOHN.person_id }).items;
  assert.equal(bus[0].pick, 'public');
  assert.match(buildProposal(bus, S, TZ, ADULTS).lines[0], /pick-up by public transport/);
  // A leave time that reaches Acro after it starts is asked again; so is an unknown leg adult.
  const late = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'taxi' }, { n: 2, who: 'me', leave_time: '15:20' }] }, { trips, adults: ADULTS, askerId: JOHN.person_id }).items;
  assert.match(buildProposal(late, S, TZ, ADULTS).ask, /Leaving at 15:20 you would reach Acro @ Dunearn - Ang at 15:42, after it starts at 15:30/);
  assert.match(checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', pick_who: 'Uncle Bob' }, { n: 2, who: 'taxi' }] }, { trips, adults: ADULTS, askerId: JOHN.person_id }).ask, /Who is "Uncle Bob"/);
  // Both by John with a leave time too late for the chain: asked again, nothing proposed.
  const chainLate = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', leave_time: '15:10' }, { n: 2, who: 'me' }] }, { trips, adults: ADULTS, askerId: JOHN.person_id }).items;
  assert.match(buildProposal(chainLate, S, TZ, ADULTS, { betweenMin: 15 }).ask, /Leaving at 15:10 you cannot reach both/);
});

test('children typed in one by one: no "who is" question in the first minutes after the list changed', async () => {
  const fresh = { ...CEL, updated_at: at('2026-11-27T16:50:00').toISOString() };
  const db = fakeTripsDb({ settings: { ...S }, adults: [JOHN], modes: MODES, children: [fresh] });
  let now = at('2026-11-27T16:52:00');
  db.setClock(() => now.getTime());
  const deps = { job: db.job, google: { list: async () => [ev('af', 'AF - Ang', '2026-11-28T09:30', '2026-11-28T11:30', '258130')] }, onemap };
  const r = await tickFamily(await db.job.load(), deps, now);
  assert.equal(r.outbox.filter((m) => m.kind === 'unknown').length, 0, 'not asked 2 minutes after a child was added');
  db.settings.last_scan_at = null;
  now = at('2026-11-27T17:01:00');
  const r2 = await tickFamily(await db.job.load(), deps, now);
  assert.equal(r2.outbox.filter((m) => m.kind === 'unknown').length, 1, 'asked once the list has settled');
});

test('own plan: Ballet by taxi there, John picks up both - the two pick-ups become one run', () => {
  const items = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'taxi', pick_who: 'me' }, { n: 2, who: 'me' }] }, { trips: [ballet, acro], adults: ADULTS, askerId: JOHN.person_id }).items;
  const b = buildProposal(items, S, TZ, ADULTS, { betweenMin: 15 });
  assert.equal(b.ask, undefined, b.ask);
  assert.match(b.lines[1], /Acro @ Dunearn - Ang.*drop-off by John \(leave 14:58\); pick-up by John \(leave 16:33, then Ballet @ River - Cel\)/);
  assert.match(b.lines[0], /Ballet @ River - Cel.*drop-off by taxi .*; pick-up by John \(leave 17:02, after Acro @ Dunearn - Ang\)/);
});

test('reminder text follows the leg: taxi there, the adult drives back', async () => {
  const { reminderMessage } = await import('../lib/trips/messages.js');
  const t = { ...ballet, owner_mode: 'taxi', pick_person: JOHN.person_id, drop_leave_at: '2026-11-28T15:11:00+08:00', pick_leave_at: '2026-11-28T17:02:00+08:00',
    pick_note: 'after Acro @ Dunearn - Ang', drive_source: 'onemap' };
  assert.match(reminderMessage('drop', t, TZ).text, /^Book the taxi now: drop-off for Ballet/);
  assert.match(reminderMessage('pick', t, TZ).text, /^Time to leave: pick-up from Ballet @ River - Cel.*\(after Acro @ Dunearn - Ang\)\. Drive about 9 min\./);
});
