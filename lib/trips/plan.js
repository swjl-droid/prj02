// Trip arithmetic for prj02-R1 US-3 (decision 'US-3 release-1 slice', option B). Pure functions:
// the code, never the model, works out leave times, quiet hours and clashes (AI-L06 agent card,
// line 6: "the model never does the sums").
//
//   leave for drop-off = event start - drive time - drop buffer (10 min)
//   leave for pick-up  = event end   - drive time - pick buffer (5 min)
//   a message due in quiet hours (22:00-07:00) is sent at the evening slot (21:30) before it
//   two trips clash when the car is needed for both at once and the family has fewer cars
//   stay rule (US-6, Hub row 283): events at the same place that follow each other within
//   stay_gap_minutes are one stay: a drop-off only before the first, a pick-up only after the last;
//   with the calendar convention (US-7) only for the same child

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

/** The place of a location: its Singapore postal code when it has one, else its key. */
export function placeId(loc) {
  const postal = String(loc ?? '').match(/(?<![0-9])([0-9]{6})(?![0-9])/)?.[1];
  return postal ? `sg:${postal}` : placeKey(loc) || null;
}

/** A location as shown to people: "139654, Singapore 139654" (Google's way of saving a typed postal code) -> "139654". */
export function placeLabel(loc) {
  const t = String(loc ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)[,\s]*Singapore\s+([0-9]{6})$/i);
  if (m && (m[1].trim() === m[2] || m[1].trim() === '')) return m[2];
  if (m && m[1].includes(m[2])) return m[1].replace(/[,\s]+$/, '');
  return t;
}

/**
 * Stay rule: for timed events sorted by start, which drop-offs and pick-ups are needed. An event
 * that starts within gapMin after the previous one ends (or while it runs) at the same place needs
 * no drop-off, and the previous one needs no pick-up. Returns Map(event id -> {drop, pick, after}).
 */
export function stays(events, gapMin, whoOf = null) {
  const evs = events.filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({ e, s: Date.parse(e.start.dateTime), t: Date.parse(e.end.dateTime), p: placeId(e.location), c: whoOf?.(e) ?? null }))
    .sort((a, b) => a.s - b.s);
  // With the calendar convention (US-7), a stay is per child: b follows a only for a child in both.
  const sameChild = (a, b) => a.c === null || b.c === null || a.c.some((x) => b.c.includes(x));
  const out = new Map(evs.map((x) => [x.e.id, { drop: true, pick: true, after: null }]));
  for (let i = 0; i < evs.length; i++) {
    for (let j = 0; j < evs.length; j++) {
      const a = evs[i]; const b = evs[j];
      if (i === j || !a.p || a.p !== b.p || !sameChild(a, b)) continue;
      // b follows a at the same place: b starts after a started, and no later than gapMin after a ends.
      if (b.s > a.s && b.s <= a.t + gapMin * MIN && b.t >= a.t) {
        out.get(b.e.id).drop = false; out.get(b.e.id).after = a.e.summary ?? null;
        out.get(a.e.id).pick = false;
      }
    }
  }
  return out;
}

export function leaveTimes(startIso, endIso, driveMin, s, pickAtIso = null) {
  const start = Date.parse(startIso); const end = Date.parse(pickAtIso ?? endIso);
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
  const start = Date.parse(t.event_start); const end = Date.parse(t.pick_at ?? t.event_end);
  const legs = [];
  const byCar = (m) => !['none', 'taxi', 'public'].includes(m); // a leg by taxi or public transport needs no car (US-8)
  if (t.drop_needed !== false && byCar(t.drop_mode)) legs.push(Object.assign([Date.parse(t.drop_leave_at), start], { kind: 'drop', at: start }));
  if (t.pick_needed !== false && byCar(t.pick_mode)) legs.push(Object.assign([Date.parse(t.pick_leave_at), end + t.drive_min * MIN], { kind: 'pick', at: end }));
  return legs; // only the legs that are needed (stay rule, the adult's own plan)
}

/**
 * Two legs that one car can do as one: both drop-offs (or both pick-ups) at the same place within
 * 15 minutes of each other (two children to the same pool). US-7: with children known, this is
 * no longer a clash.
 */
export function sharedLeg(a, x, b, y) {
  const pa = placeId(a.location); const pb = placeId(b.location);
  return !!pa && pa === pb && x.kind === y.kind && Math.abs(x.at - y.at) <= 15 * MIN;
}

/** True when the trip needs no drive at all (both legs unneeded). */
export const noLegs = (t) => carLegs(t).length === 0;

const overlap = ([a1, a2], [b1, b2]) => a1 < b2 && b1 < a2;

/** Pairs of trips that need the car at the same time, when the family has fewer cars than needed. */
export function findClashes(trips, cars) {
  if (cars >= 2) return []; // release 1: clashes of two trips with one car
  if (cars <= 0) return [];
  const byCar = trips.filter((t) => t.status !== 'cancelled' && t.owner_mode !== 'taxi' && t.owner_mode !== 'public'
    && (t.who_state ?? 'child') === 'child');
  const out = [];
  for (let i = 0; i < byCar.length; i++) {
    for (let j = i + 1; j < byCar.length; j++) {
      const a = byCar[i]; const b = byCar[j];
      if (a.status === 'assigned' && b.status === 'assigned') continue; // already agreed by the adults
      if (carLegs(a).some((x) => carLegs(b).some((y) => overlap(x, y) && !sharedLeg(a, x, b, y)))) out.push([a, b]);
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
