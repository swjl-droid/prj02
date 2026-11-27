// prj02-R1 US-9: ways of doing a trip (decision Hub row 308, gap Hub row 307). Every message with
// buttons offers at most 3 options (the usual choice of the activity first, then the rules), then
// "Other ways…" (how, then who) and "My own plan…"; a tapped choice is taken once. First test case:
// John's real AF on Sat 28/11 (Ang, 09:30-11:30, 16 min from home), which the family does as "drop
// off, wait there, pick up".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickFamily } from '../lib/trips/tick.js';
import { handleTripButton } from '../lib/bot/trips.js';
import { checkPlan, buildProposal } from '../lib/bot/plan.js';
import { rankOptions, optionOf, wayTimes, allOptions } from '../lib/trips/ways.js';
import { reminderMessage } from '../lib/trips/messages.js';
import { carLegs } from '../lib/trips/plan.js';
import { localParts } from '../lib/calendar/dates.js';
import { settings } from '../lib/config.js';
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
const WS = { ...S, max_options: 3, history_count: 4, wait_max_minutes: 120, walk_max_minutes: 15 };
const WAYS = settings.trip_ways;

const ev = (id, title, s, e, loc) => ({ id, summary: title, location: loc, start: { dateTime: `${s}:00+08:00` }, end: { dateTime: `${e}:00+08:00` } });
const fakeOnemap = (walkMin) => ({
  find: async () => ({ lat: 1.36, lng: 103.75 }),
  async routeMinutes(from, to, route) { return route === 'walk' ? walkMin : route === 'pt' ? 35 : 16; },
});

async function afEvening({ adults = [JOHN], walkMin = 40, history = [], end = '2026-11-28T11:30' } = {}) {
  const db = fakeTripsDb({ settings: S, adults, modes: MODES, children: [ANG] });
  db.trips.push(...history);
  const now = at('2026-11-27T19:00:00');
  db.setClock(() => now.getTime());
  const deps = { job: db.job, google: { list: async () => [ev('af', 'AF - Ang', '2026-11-28T09:30', end, '258130')] }, onemap: fakeOnemap(walkMin) };
  const r = await tickFamily(await db.job.load(), deps, now);
  const msg = r.outbox.find((m) => m.kind === 'plan' && m.chat === 111);
  return { db, msg, now, deps };
}

test("John's AF, first time, one adult: wait there, there and back, taxi back - then Other ways and My own plan", async () => {
  const { msg } = await afEvening();
  assert.match(msg.reply.text, /^Tomorrow: AF - Ang, Sat 28 Nov, 09:30-11:30 at 258130\./);
  assert.match(msg.reply.text, /Option 1: John drives there \(leave 09:04\), waits there, picks up at 11:30 \(home ~11:46\)\./);
  assert.match(msg.reply.text, /Option 2: John drives there \(leave 09:04\), drives back \(leave 11:09\)\./);
  assert.match(msg.reply.text, /Option 3: John drives there \(leave 09:04\), taxi back \(book 10:59\)\./);
  assert.doesNotMatch(msg.reply.text, /Option 4/, 'at most 3 options');
  assert.deepEqual(msg.reply.buttons.map((row) => row.map((b) => b.label)), [['Option 1', 'Option 2', 'Option 3'], ['Other ways…'], ['My own plan…']]);
});

test('Option 1 tapped: one adult waits there; the message shows the choice; a second tap changes nothing', async () => {
  const { db, msg } = await afEvening();
  const john = db.botStore(JOHN.person_id);
  db.setClock(() => at('2026-11-27T20:08:16').getTime());
  const [done] = await handleTripButton(msg.reply.buttons[0][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ, now: () => at('2026-11-27T20:08:16') });
  assert.equal(done.edit, true);
  assert.match(done.text, /^Chosen by John at 20:08:\nDone: AF - Ang \(Sat 28 Nov, 09:30-11:30\): John L takes it \(waits there\)\. Reminders: leave 09:04 for drop-off, waiting there, pick-up at 11:30 \(reminder 11:25\)\./);
  assert.deepEqual(done.buttons.flat().map((b) => b.label), ['My own plan…'], 'no options left to tap');
  const t = db.trips[0];
  assert.equal(t.wait_there, true);
  const due = () => db.reminders.filter((m) => m.status === 'due' && ['drop', 'pick'].includes(m.kind)).map((m) => `${m.kind} ${hm(m.send_at)}`).sort();
  assert.deepEqual(due(), ['drop 09:04', 'pick 11:25']);
  assert.equal(reminderMessage('pick', t, TZ).text, 'Pick-up at 11:30 (you are there): AF - Ang, Sat 28 Nov, 09:30-11:30 at 258130.');
  assert.deepEqual(carLegs(t).map((l) => [hm(l[0]), hm(l[1]), l.kind]), [['09:04', '11:46', 'stay']], 'the car is at AF the whole time');
  // The same tap one second later (John tapped twice at 20:08:16 and 20:08:17): nothing changes.
  const again = await handleTripButton(msg.reply.buttons[0][1].action, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  assert.equal(again[0].edit, 'buttons');
  assert.match(again[1].text, /^Already chosen by John at 20:08\. Nothing changed\./);
  assert.equal(t.wait_there, true, 'option 2 was not applied');
  assert.deepEqual(due(), ['drop 09:04', 'pick 11:25']);
});

test("Other ways…: how, then who; one adult goes straight to the choice; two adults pick who", async () => {
  const one = await afEvening();
  const m = one.msg.reply.buttons[1][0].action; // 'ow:<message>'
  const store = one.db.botStore(JOHN.person_id);
  const [how] = await handleTripButton(m, { person_id: JOHN.person_id }, store, { timeZone: TZ });
  assert.equal(how.edit, 'buttons');
  assert.deepEqual(how.buttons.flat().map((b) => b.label), ['Drop off and wait', 'Drop off, someone picks up', 'Car there, taxi back',
    'Car there, public transport back', 'Taxi there, car back', 'Public transport there, taxi back', '« Back'], 'no walk: 40 min on foot');
  const publicBack = how.buttons.flat().find((b) => b.label === 'Car there, public transport back').action;
  const [done] = await handleTripButton(publicBack, { person_id: JOHN.person_id }, store, { timeZone: TZ });
  assert.equal(done.edit, true);
  assert.match(done.text, /John L takes it \(pick-up: public transport\)\. Reminders: leave 09:04 for drop-off, 10:50 for pick-up\./);
  const [back] = await handleTripButton(`ob:${m.slice(3)}`, { person_id: JOHN.person_id }, store, { timeZone: TZ });
  assert.deepEqual(back.buttons.map((r) => r.length), [3, 1, 1]);

  const two = await afEvening({ adults: [JOHN, MEI] });
  const s2 = two.db.botStore(JOHN.person_id);
  const m2 = two.msg.reply.buttons[1][0].action;
  const [how2] = await handleTripButton(m2, { person_id: JOHN.person_id }, s2, { timeZone: TZ });
  const split = how2.buttons.flat().find((b) => b.label === 'Drop off, someone picks up').action;
  const [who] = await handleTripButton(split, { person_id: JOHN.person_id }, s2, { timeZone: TZ });
  assert.deepEqual(who.buttons.flat().map((b) => b.label), ['John', 'John there, Mei back', 'Mei there, John back', 'Mei', '« Back']);
  const [done2] = await handleTripButton(who.buttons[1][0].action, { person_id: JOHN.person_id }, s2, { timeZone: TZ });
  assert.match(done2.text, /John L takes it \(pick-up: Mei\)/);
  assert.equal(two.db.reminders.find((r) => r.kind === 'pick' && r.status === 'due').person_id, MEI.person_id, 'Mei gets the pick-up reminder');
  // A made-up adult in the button: refused.
  const fake = who.buttons[1][0].action.replace(/:[0-9a-f]{8}$/, ':deadbeef');
  assert.match((await handleTripButton(fake, { person_id: JOHN.person_id }, s2, { timeZone: TZ }))[0].text, /not possible/);
});

// Four past Saturdays of AF: John waited three times, once Mei dropped off and John picked up.
const past = (day, o) => ({ id: `past-${day}`, status: 'assigned', title: 'AF - Ang', child_ids: [ANG.id], event_start: `2026-11-${day}T01:30:00.000Z`,
  event_end: `2026-11-${day}T03:30:00.000Z`, owner_mode: 'adult', owner_person_id: JOHN.person_id, drop_mode: null, pick_mode: null,
  drop_person: null, pick_person: null, wait_there: false, ...o });

test('the usual choice of AF comes first: 3 of the last 4 waits by John, then Mei-John, then the rules', async () => {
  const history = [past('07', { wait_there: true }), past('14', { owner_person_id: MEI.person_id, pick_person: JOHN.person_id }),
    past('21', { wait_there: true }), past('31', {}) /* not a past Saturday of AF */, past('24', { wait_there: true }),
    past('17', { title: 'Piano - Ang', wait_there: false }) /* another activity */, past('10', { owner_mode: 'taxi', owner_person_id: null }) /* older than the last 4 */];
  history[3].event_start = '2026-12-05T01:30:00.000Z';
  const { msg } = await afEvening({ adults: [JOHN, MEI], history });
  assert.match(msg.reply.text, /Option 1: John drives there \(leave 09:04\), waits there/);
  assert.match(msg.reply.text, /Option 2: Mei drives there \(leave 09:04\), John picks up \(leave 11:09\)/);
  assert.match(msg.reply.text, /Option 3: Mei drives there \(leave 09:04\), waits there/);
});

test('four different past choices: the 3 most recent first, the 4th under Other ways', () => {
  const trip = { id: 'now', title: 'AF - Ang', child_ids: [ANG.id], event_start: '2026-11-28T01:30:00.000Z', event_end: '2026-11-28T03:30:00.000Z',
    drive_min: 16, drop_leave_at: '2026-11-28T01:04:00.000Z', pick_leave_at: '2026-11-28T03:09:00.000Z' };
  const minutes = { car: 16, taxi: 26, public: 35, walk: null };
  const times = wayTimes(trip, WAYS, minutes, WS, TZ);
  const ways = WAYS.filter((w) => times[w.id]).map((w) => ({ ...w, times: times[w.id] }));
  const history = [past('07', { pick_mode: 'taxi' }), past('14', { pick_mode: 'public' }), past('21', { drop_mode: 'taxi' }), past('24', {})];
  const adults = [JOHN];
  const { top, rest } = rankOptions(trip, { ways, adults, history, minutes, s: WS });
  assert.deepEqual(top.map((o) => o.way), ['back', 'taxi_car', 'car_public'], 'most recent first (all once)');
  assert.equal(rest[0].way, 'car_taxi', 'the 4th past choice leads Other ways');
  assert.ok(rest.some((o) => o.way === 'wait'));
});

test('2½-hour activity: no wait in the 3 options (still under Other ways); walk 10 min comes first, 20 min never', async () => {
  const long = await afEvening({ adults: [JOHN, MEI], end: '2026-11-28T12:00' });
  assert.doesNotMatch(long.msg.reply.text, /waits there/);
  assert.match(long.msg.reply.text, /Option 1: John drives there \(leave 09:04\), drives back/);
  assert.match(long.msg.reply.text, /Option 2: Mei drives there \(leave 09:04\), drives back/);
  assert.match(long.msg.reply.text, /Option 3: John drives there \(leave 09:04\), Mei picks up/);
  const [how] = await handleTripButton(long.msg.reply.buttons[1][0].action, { person_id: JOHN.person_id }, long.db.botStore(JOHN.person_id), { timeZone: TZ });
  assert.ok(how.buttons.flat().some((b) => b.label === 'Drop off and wait'));

  const near = await afEvening({ walkMin: 10 });
  assert.match(near.msg.reply.text, /Option 1: John walks there \(leave 09:10\), walks back \(leave 11:15\)\./);
  const far = await afEvening({ walkMin: 20 });
  assert.doesNotMatch(far.msg.reply.text, /walk/);
  const [howFar] = await handleTripButton(far.msg.reply.buttons[1][0].action, { person_id: JOHN.person_id }, far.db.botStore(JOHN.person_id), { timeZone: TZ });
  assert.ok(!howFar.buttons.flat().some((b) => b.label === 'Walk'));
});

test('My own plan… under the AF message: "drop off, wait and pick up" is applied as a wait and counts as the usual choice', async () => {
  const { db, msg } = await afEvening();
  const john = db.botStore(JOHN.person_id);
  const [prompt] = await handleTripButton(msg.reply.buttons[2][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ, planValidMinutes: 30 });
  assert.match(prompt.text, /Tell me your plan/);
  const pending = await john.planPending();
  const trips = [db.trips[0]];
  const adults = [{ id: JOHN.person_id, display_name: 'John L' }];
  const items = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', wait: 'yes' }] }, { trips, adults, askerId: JOHN.person_id }).items;
  const built = buildProposal(items, S, TZ, adults);
  assert.match(built.lines[0], /drop-off by John \(leave 09:04\); pick-up by John \(waiting there\)/);
  assert.equal(built.proposal[0].wait, true);
  await john.planPropose(pending.plan, built.proposal);
  await john.planDecide(pending.plan, true);
  assert.deepEqual(optionOf(db.trips[0], WAYS), { way: 'wait', drop_by: JOHN.person_id, pick_by: JOHN.person_id });
  // A wait with two adults is refused in code; an own plan matching no way does not become a button.
  const two = [...adults, { id: MEI.person_id, display_name: 'Mei' }];
  const split = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', wait: 'yes', pick_who: 'Mei' }] }, { trips, adults: two, askerId: JOHN.person_id }).items;
  assert.match(buildProposal(split, S, TZ, two).ask, /one adult does the drop-off and the pick-up/);
  assert.equal(optionOf({ ...db.trips[0], pick_mode: 'none', wait_there: false }, WAYS), null);
  // Walking with the child: legs on foot need no car.
  const walk = checkPlan({ intent: 'plan', trips: [{ n: 1, who: 'me', walk: 'both' }] }, { trips, adults, askerId: JOHN.person_id }).items;
  const w = buildProposal(walk, S, TZ, adults);
  assert.match(w.lines[0], /drop-off on foot with John .*pick-up on foot with John/);
  assert.deepEqual([w.proposal[0].drop, w.proposal[0].pick], ['walk', 'walk']);
});

test('a clash, Other ways…: one activity at a time, then the other', async () => {
  const db = fakeTripsDb({ settings: S, adults: [JOHN], modes: MODES, children: [ANG, { id: 'cccc2222-0000-4000-8000-000000000002', name: 'Celine', aliases: ['Cel'] }] });
  const now = at('2026-11-27T19:00:00');
  db.setClock(() => now.getTime());
  const events = [ev('ballet', 'Ballet @ River - Cel', '2026-11-28T15:30', '2026-11-28T17:30', '248371'), ev('acro', 'Acro @ Dunearn - Ang', '2026-11-28T15:30', '2026-11-28T17:00', '589472')];
  const r = await tickFamily(await db.job.load(), { job: db.job, google: { list: async () => events }, onemap: fakeOnemap(40) }, now);
  const clash = r.outbox.find((m) => m.kind === 'clash');
  assert.deepEqual(clash.reply.buttons.slice(1).flat().map((b) => b.label), ['Other ways…', 'My own plan…']);
  const john = db.botStore(JOHN.person_id);
  const [which] = await handleTripButton(clash.reply.buttons[1][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  assert.deepEqual(which.buttons.flat().map((b) => b.label), ['Ballet @ River - Cel', 'Acro @ Dunearn - Ang', '« Back']);
  const [how] = await handleTripButton(which.buttons[0][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  const taxiCar = how.buttons.flat().find((b) => b.label === 'Taxi there, car back').action;
  const [first] = await handleTripButton(taxiCar, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  assert.match(first.text, /Done: Ballet @ River - Cel .*John L takes it \(drop-off: taxi\)/);
  assert.match(first.text, /Now Acro @ Dunearn - Ang: how\?$/);
  const wait = first.buttons.flat().find((b) => b.label === 'Drop off and wait').action;
  const [second] = await handleTripButton(wait, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  assert.match(second.text, /Acro @ Dunearn - Ang .*John L takes it \(waits there\)/);
  assert.deepEqual(second.buttons.flat().map((b) => b.label), ['My own plan…']);
  // Both decided: Option 1 of the clash is now refused as already chosen.
  const late = await handleTripButton(clash.reply.buttons[0][0].action, { person_id: JOHN.person_id }, john, { timeZone: TZ });
  assert.match(late[1].text, /Already chosen by John/);
});

test('options for every adult and way are built, never stored: a wait is one adult, walk only when it qualifies', () => {
  const adults = [JOHN, MEI];
  const all = allOptions(WAYS, adults, (w) => w.drop !== 'walk');
  assert.equal(all.filter((o) => o.way === 'wait').length, 2);
  assert.equal(all.filter((o) => o.way === 'back').length, 4);
  assert.equal(all.filter((o) => o.way === 'public_taxi').length, 1);
  assert.equal(all.length, 2 + 4 + 2 + 2 + 2 + 1, 'the 11 ways of John\'s list for two parents (walk not shown)');
});
