// Travel time per way of travel (prj02-R1 US-3, decision 27/11/2026, Hub row 277): car, taxi
// (drive time + booking lead) and public transport (OneMap public-transport route), each with the
// family's estimate when OneMap cannot tell. John's values: car 30, taxi 30 + 10, public 60.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { travelMinutes, modeOf, tickFamily } from '../lib/trips/tick.js';
import { oneMap, sgDateTime, _resetOneMapToken } from '../lib/route/onemap.js';
import { handleTripButton } from '../lib/bot/trips.js';
import { localParts } from '../lib/calendar/dates.js';
import { fakeTripsDb } from './fake-trips.js';

const TZ = 'Asia/Singapore';
const at = (s) => new Date(`${s}+08:00`);
const local = (d) => { const p = localParts(TZ, new Date(d)); return `${p.date} ${p.time}`; };
const JOHN_MODES = { car: { route: 'drive', estimate_min: 30, lead_min: 0 }, taxi: { route: 'drive', estimate_min: 30, lead_min: 10 },
  public: { route: 'pt', estimate_min: 60, lead_min: 0 } };
const FAM = { country: 'SG', home: { lat: 1.27, lng: 103.82 } };

function fakeRoute({ fail = false } = {}) {
  const calls = { find: 0, drive: 0, pt: 0 };
  return {
    calls,
    find: async (q) => { calls.find++; return /569933/.test(q) ? { lat: 1.35, lng: 103.85 } : null; },
    routeMinutes: async (_f, _t, route) => {
      calls[route]++;
      if (fail) { const e = new Error('x'); e.type = 'route_failed'; throw e; }
      return route === 'pt' ? 41 : 17;
    },
  };
}
const saver = () => ({ saved: [], savePlace: async function (...a) { this.saved.push(a); } });

test('estimates per way of travel when there is no location: car 30, taxi 30 + 10, public 60', async () => {
  for (const [mode, want] of [['car', 30], ['taxi', 40], ['public', 60]]) {
    const r = await travelMinutes(null, JOHN_MODES[mode], FAM, new Map(), { onemap: fakeRoute() }, [], new Date());
    assert.deepEqual(r, { min: want, source: 'estimate' }, mode);
  }
});

test('OneMap per route: drive for car and taxi (+ lead), public transport route for public', async () => {
  const om = fakeRoute(); const job = saver(); const places = new Map(); const note = [];
  const deps = { onemap: om, job };
  const where = '569933, Singapore 569933';
  assert.deepEqual(await travelMinutes(where, JOHN_MODES.car, FAM, places, deps, note, new Date()), { min: 17, source: 'onemap' });
  assert.deepEqual(await travelMinutes(where, JOHN_MODES.taxi, FAM, places, deps, note, new Date()), { min: 27, source: 'onemap' });
  assert.deepEqual(await travelMinutes(where, JOHN_MODES.public, FAM, places, deps, note, new Date()), { min: 41, source: 'onemap' });
  // One place search (coordinates reused), one drive route (taxi reuses it), one public-transport route.
  assert.deepEqual(om.calls, { find: 1, drive: 1, pt: 1 });
  assert.deepEqual(job.saved.map((s) => s[5]), ['drive', 'pt']);
  assert.deepEqual(note, []);
});

test('OneMap down or place unknown: the estimate of that way of travel, and the error kind noted', async () => {
  const note = [];
  const r = await travelMinutes('569933', JOHN_MODES.public, FAM, new Map(), { onemap: fakeRoute({ fail: true }), job: saver() }, note, new Date());
  assert.deepEqual(r, { min: 60, source: 'estimate' });
  assert.deepEqual(note, ['onemap:route_failed']);
  const note2 = [];
  const r2 = await travelMinutes('Rue de la Loi 16, Bruxelles', JOHN_MODES.taxi, FAM, new Map(), { onemap: fakeRoute(), job: saver() }, note2, new Date());
  assert.deepEqual(r2, { min: 40, source: 'estimate' });
  assert.deepEqual(note2, ['onemap:not_found']);
  // Abroad family: never OneMap.
  const om = fakeRoute();
  assert.equal((await travelMinutes('569933', JOHN_MODES.car, { country: 'BE', home: null }, new Map(), { onemap: om }, [], new Date())).min, 30);
  assert.equal(om.calls.find, 0);
});

test('way of travel of a trip: open or adult = car; taxi; public transport', () => {
  assert.equal(modeOf(undefined), 'car');
  assert.equal(modeOf({ owner_mode: null }), 'car');
  assert.equal(modeOf({ owner_mode: 'adult' }), 'car');
  assert.equal(modeOf({ owner_mode: 'taxi' }), 'taxi');
  assert.equal(modeOf({ owner_mode: 'public' }), 'public');
});

test('OneMap public-transport request: Singapore date and time, duration read from the itinerary', async () => {
  assert.deepEqual(sgDateTime(new Date('2026-11-28T01:30:00Z')), { date: '11-28-2026', time: '09:30:00' });
  assert.deepEqual(sgDateTime(new Date('2026-12-31T16:05:09Z')), { date: '01-01-2027', time: '00:05:09' });
  _resetOneMapToken();
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/getToken')) return { ok: true, json: async () => ({ access_token: 't', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 86400 * 3) }) };
    asked.push(Object.fromEntries(u.searchParams));
    return { ok: true, json: async () => (u.searchParams.get('routeType') === 'pt'
      ? { plan: { itineraries: [{ duration: 2461 }] } } : { route_summary: { total_time: 1015 } }) };
  };
  const om = oneMap({ email: 'e', password: 'p', fetchImpl });
  const from = { lat: 1.27, lng: 103.82 }; const to = { lat: 1.35, lng: 103.85 };
  assert.equal(await om.routeMinutes(from, to, 'pt', at('2026-11-28T09:30:00')), 42);
  assert.equal(await om.routeMinutes(from, to, 'drive'), 17);
  assert.equal(await om.driveMinutes(from, to), 17);
  assert.equal(asked[0].routeType, 'pt');
  assert.equal(asked[0].date, '11-28-2026');
  assert.equal(asked[0].time, '09:30:00');
  assert.equal(asked[0].mode, 'TRANSIT');
  assert.equal(asked[1].date, undefined, 'a drive request has no date');
});

test('a tap on "Public transport" re-plans the trip at the next tick: leave time from the public-transport route', async () => {
  const S = { home_postal: '098652', home_lat: 1.27, home_lng: 103.82, cars: 1, plan_time: '19:00:00', quiet_start: '22:00:00',
    quiet_end: '07:00:00', evening_slot: '21:30:00', drop_buffer_min: 10, pick_buffer_min: 5, scan_minutes: 15, last_scan_at: null };
  const JOHN = { person_id: 'aaaaaaaa-0000-4000-8000-000000000001', display_name: 'John', can_drive: true, chat: 111 };
  const db = fakeTripsDb({ settings: S, adults: [JOHN], modes: JOHN_MODES });
  let now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const events = [{ id: 'swim', summary: 'Swim', location: '569933, Singapore 569933',
    start: { dateTime: '2026-11-28T15:00:00+08:00' }, end: { dateTime: '2026-11-28T16:00:00+08:00' } }];
  const deps = { job: db.job, google: { list: async () => events }, onemap: fakeRoute() };
  await tickFamily(await db.job.load(), deps, now);
  const trip = db.trips[0];
  assert.equal(local(trip.drop_leave_at), '2026-11-28 14:33', 'car: 15:00 - 17 - 10');
  // John taps Public transport in the 'who takes it?' message.
  await handleTripButton(`tr:${trip.id}:pub`, { person_id: JOHN.person_id }, db.botStore(JOHN.person_id), { timeZone: TZ });
  assert.equal(db.settings.last_scan_at, null, 'the tap asks for a new scan');
  now = at('2026-11-28T08:01:00');
  await tickFamily(await db.job.load(), deps, now);
  assert.equal(local(trip.drop_leave_at), '2026-11-28 14:09', 'public transport: 15:00 - 41 - 10');
  assert.equal(local(trip.pick_leave_at), '2026-11-28 15:14', 'public transport back: 16:00 - 41 - 5');
  const drop = db.reminders.find((r) => r.trip_id === trip.id && r.kind === 'drop');
  assert.equal(local(drop.send_at), '2026-11-28 14:09', 'the reminder follows the new leave time');
});

test('a family without travel modes keeps its trips (never cancels them) and notes the error kind', async () => {
  const S = { home_postal: null, home_lat: null, home_lng: null, cars: 1, plan_time: '19:00:00', quiet_start: '22:00:00',
    quiet_end: '07:00:00', evening_slot: '21:30:00', drop_buffer_min: 10, pick_buffer_min: 5, scan_minutes: 15, last_scan_at: null };
  const db = fakeTripsDb({ settings: S, adults: [], modes: JOHN_MODES });
  const now = at('2026-11-28T08:00:00');
  db.setClock(() => now.getTime());
  const events = [{ id: 'x', summary: 'Swim', start: { dateTime: '2026-11-28T15:00:00+08:00' }, end: { dateTime: '2026-11-28T16:00:00+08:00' } }];
  const deps = { job: db.job, google: { list: async () => events }, onemap: null };
  await tickFamily(await db.job.load(), deps, now);
  assert.equal(db.trips.length, 1);
  const fam = { ...(await db.job.load()), modes: {} };
  db.settings.last_scan_at = null;
  const r = await tickFamily(fam, deps, now);
  assert.deepEqual(r.scanned.note, ['travel_mode:missing']);
  assert.equal(db.trips[0].status, 'open', 'not cancelled');
});
