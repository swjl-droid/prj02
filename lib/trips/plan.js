// Trip arithmetic for prj02-R1 US-3 (decision 'US-3 release-1 slice', option B). Pure functions:
// the code, never the model, works out leave times, quiet hours and clashes (AI-L06 agent card,
// line 6: "the model never does the sums").
//
//   leave for drop-off = event start - drive time - drop buffer (10 min)
//   leave for pick-up  = event end   - drive time - pick buffer (5 min)
//   a message due in quiet hours (22:00-07:00) is sent at the evening slot (21:30) before it
//   two trips clash when the car is needed for both at once and the family has fewer cars

import { localParts, addDays, isoAt } from '../calendar/dates.js';

const MIN = 60_000;
const hm = (t) => String(t).slice(0, 5); // '19:00:00' -> '19:00'

/** Which calendar events become trips: timed, not cancelled, not made by the bot for itself. */
export function isActivity(ev) {
  return !!ev && ev.status !== 'cancelled' && !!ev.start?.dateTime && !!ev.end?.dateTime
    && !/^\s*🚗/u.test(ev.summary ?? '');
}

/** The key under which a location's drive time is saved (case and spacing do not matter). */
export const placeKey = (loc) => String(loc ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);

export function leaveTimes(startIso, endIso, driveMin, s) {
  const start = Date.parse(startIso); const end = Date.parse(endIso);
  return {
    dropLeave: new Date(start - (driveMin + s.drop_buffer_min) * MIN),
    pickLeave: new Date(end - (driveMin + s.pick_buffer_min) * MIN),
  };
}

/** True when the instant falls in quiet hours (quiet_start..24:00 or 00:00..quiet_end). */
export function inQuiet(at, s, tz) {
  const t = localParts(tz, at).time;
  const qs = hm(s.quiet_start); const qe = hm(s.quiet_end);
  return qs > qe ? (t >= qs || t < qe) : (t >= qs && t < qe);
}

/** When a message due at `at` may go out: at once, or at the evening slot before quiet hours. */
export function sendTime(at, s, tz) {
  if (!inQuiet(at, s, tz)) return at;
  const p = localParts(tz, at);
  const day = p.time >= hm(s.quiet_start) ? p.date : addDays(p.date, -1);
  return new Date(isoAt(day, hm(s.evening_slot), tz));
}

/** The intervals the car is in use for a trip: the drive there, and the drive back with the child. */
export function carLegs(t) {
  const start = Date.parse(t.event_start); const end = Date.parse(t.event_end);
  return [
    [Date.parse(t.drop_leave_at), start],
    [Date.parse(t.pick_leave_at), end + t.drive_min * MIN],
  ];
}

const overlap = ([a1, a2], [b1, b2]) => a1 < b2 && b1 < a2;

/** Pairs of trips that need the car at the same time, when the family has fewer cars than needed. */
export function findClashes(trips, cars) {
  if (cars >= 2) return []; // release 1: clashes of two trips with one car
  if (cars <= 0) return [];
  const byCar = trips.filter((t) => t.status !== 'cancelled' && t.owner_mode !== 'taxi' && t.owner_mode !== 'public');
  const out = [];
  for (let i = 0; i < byCar.length; i++) {
    for (let j = i + 1; j < byCar.length; j++) {
      const a = byCar[i]; const b = byCar[j];
      if (a.status === 'assigned' && b.status === 'assigned') continue; // already agreed by the adults
      if (carLegs(a).some((x) => carLegs(b).some((y) => overlap(x, y)))) out.push([a, b]);
    }
  }
  return out;
}

/** The 2 options offered for a clash: one trip by car with the driver, the other by taxi. */
export function clashOptions([a, b], driver) {
  const car = (t) => (driver ? { trip: t.id, mode: 'adult', person: driver.person_id } : { trip: t.id, mode: 'taxi' });
  return [
    [car(a), { trip: b.id, mode: 'taxi' }],
    [car(b), { trip: a.id, mode: 'taxi' }],
  ];
}

/** The day after the local date of `at`, in the zone. */
export function tomorrowOf(at, tz) { return addDays(localParts(tz, at).date, 1); }
