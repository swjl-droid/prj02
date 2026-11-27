// Ways of doing a trip (prj02-R1 US-9, decision 27/11/2026 Hub row 308). Pure functions.
//
// The ways are a list of data (config/settings.json `trip_ways`): how the drop-off goes, how the
// pick-up goes (car, walk, taxi, public transport) and whether the adult waits there. The options of
// a message are built from that list and the family's adults when the message is made; no
// combination is stored in advance. Which 3 come first:
//   1. the choices of the last `history_count` times the same activity happened for the same
//      child(ren): the most frequent first, then the most recent;
//   2. the rules: walk when it takes `walk_max_minutes` or less; wait there when the activity lasts
//      `wait_max_minutes` or less, else there and back; each adult in turn;
//   3. the order of the list.
// The rest is under "Other ways…" (how, then who), and "My own plan…" is always there.
//
// Plain English: like a waiter who mentions your usual order first, while the menu stays the same.

import { localParts } from '../calendar/dates.js';
import { sendTime } from './plan.js';

const MIN = 60_000;
const ADULT_LEGS = new Set(['car', 'walk']); // legs an adult does (drives or walks with the child)
export const needsAdult = (mode) => ADULT_LEGS.has(mode);

/** The way a past trip's leg went: car, walk, taxi, public or none. */
export function legMode(t, leg) {
  const m = t[`${leg}_mode`];
  if (['none', 'taxi', 'public', 'walk'].includes(m)) return m;
  if (t[`${leg}_person`]) return 'car';
  return t.owner_mode === 'taxi' ? 'taxi' : t.owner_mode === 'public' ? 'public' : 'car';
}

/** Who did a past trip's leg (an adult's id), for car and walk legs. */
export function legBy(t, leg) {
  return needsAdult(legMode(t, leg)) ? (t[`${leg}_person`] ?? t.owner_person_id ?? null) : null;
}

/** The same activity for the same child(ren): "AF - Ang" on every Saturday. */
export function activityKey(t) {
  const title = String(t.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${title}|${[...(t.child_ids ?? [])].sort().join(',')}`;
}

const keyOf = (o) => `${o.way}|${o.drop_by ?? '-'}|${o.pick_by ?? '-'}`;

/** A past trip as an option of the list, or null when it matches no way (e.g. no pick-up needed). */
export function optionOf(t, ways) {
  if (t.status !== 'assigned') return null;
  const drop = legMode(t, 'drop'); const pick = legMode(t, 'pick');
  const wait = !!t.wait_there;
  const i = ways.findIndex((w) => w.drop === drop && w.pick === pick && !!w.wait === wait);
  if (i < 0) return null;
  return { way: ways[i].id, drop_by: legBy(t, 'drop'), pick_by: legBy(t, 'pick') };
}

/** Every option of the list for these adults: a way with an adult for each leg that needs one. */
export function allOptions(ways, adults, feasible) {
  const out = [];
  for (const w of ways) {
    if (!feasible(w)) continue;
    const dA = needsAdult(w.drop); const pA = needsAdult(w.pick);
    for (const a of dA ? adults : [null]) {
      for (const b of pA ? adults : [null]) {
        if (w.wait && a !== b) continue; // a wait there is one adult
        out.push({ way: w.id, drop_by: a?.person_id ?? null, pick_by: b?.person_id ?? null });
      }
    }
  }
  return out;
}

/**
 * The options of one trip, in order: past choices, then the rules, then the list. Returns
 * { top: [≤ max], rest: [...] } of { way, drop_by, pick_by }.
 */
export function rankOptions(trip, { ways, adults, history, minutes, s }) {
  const dur = (Date.parse(trip.event_end) - Date.parse(trip.event_start)) / MIN;
  const walkOk = Number.isFinite(minutes.walk) && minutes.walk <= s.walk_max_minutes;
  const feasible = (w) => (w.drop !== 'walk' && w.pick !== 'walk') || walkOk;
  const all = allOptions(ways, adults, feasible);
  const known = new Set(all.map(keyOf));
  const order = [];
  const add = (o) => { const k = keyOf(o); if (known.has(k) && !order.some((x) => keyOf(x) === k)) order.push(o); };
  // 1. Past choices of the same activity: most frequent, then most recent.
  const past = history.filter((h) => activityKey(h) === activityKey(trip) && h.id !== trip.id && Date.parse(h.event_start) < Date.parse(trip.event_start))
    .sort((a, b) => b.event_start.localeCompare(a.event_start)).slice(0, s.history_count)
    .map((h, i) => ({ o: optionOf(h, ways), i })).filter((x) => x.o);
  const counts = new Map();
  for (const { o, i } of past) {
    const c = counts.get(keyOf(o)) ?? { o, n: 0, last: i };
    c.n++; c.last = Math.min(c.last, i); counts.set(keyOf(o), c);
  }
  [...counts.values()].sort((a, b) => b.n - a.n || a.last - b.last).forEach((c) => add(c.o));
  // 2. The rules, each adult in turn.
  const byWay = (id, same) => all.filter((o) => o.way === id && (same === undefined || (o.drop_by === o.pick_by) === same));
  if (walkOk) for (const id of ways.filter((w) => w.drop === 'walk').map((w) => w.id)) byWay(id, true).forEach(add);
  const waitIds = ways.filter((w) => w.wait).map((w) => w.id);
  const backIds = ways.filter((w) => !w.wait && w.drop === 'car' && w.pick === 'car').map((w) => w.id);
  const firstIds = dur <= s.wait_max_minutes ? [...waitIds, ...backIds] : backIds;
  for (const id of firstIds) byWay(id, true).forEach(add);
  for (const id of backIds) byWay(id, false).forEach(add);
  // 3. The order of the list (a wait past the limit only under "Other ways…").
  for (const o of all) if (dur <= s.wait_max_minutes || !waitIds.includes(o.way)) add(o);
  for (const o of all) add(o);
  return { top: order.slice(0, s.max_options), rest: order.slice(s.max_options) };
}

/**
 * Leave times of each way for a trip (same for every adult): car legs keep the trip's own times
 * (null: the scan keeps them current); taxi, public transport and walk legs use their own minutes;
 * a wait there means being ready at the end. Ways that cannot be timed are left out.
 */
export function wayTimes(trip, ways, minutes, s, tz) {
  const start = Date.parse(trip.event_start); const end = Date.parse(trip.pick_at ?? trip.event_end);
  const out = {};
  for (const w of ways) {
    const dm = w.drop === 'car' ? trip.drive_min : minutes[w.drop];
    const pm = w.pick === 'car' ? trip.drive_min : minutes[w.pick];
    if (!Number.isFinite(dm) || !Number.isFinite(pm)) continue;
    const dropLeave = w.drop === 'car' ? null : new Date(start - (dm + s.drop_buffer_min) * MIN);
    const pickLeave = w.wait ? new Date(end - s.pick_buffer_min * MIN) : w.pick === 'car' ? null : new Date(end - (pm + s.pick_buffer_min) * MIN);
    const iso = (d) => (d ? d.toISOString() : null);
    out[w.id] = {
      drop_leave: iso(dropLeave), drop_send: dropLeave ? iso(sendTime(dropLeave, s, tz)) : null,
      pick_leave: iso(pickLeave), pick_send: pickLeave ? iso(sendTime(pickLeave, s, tz)) : null,
      // Shown in the message: every leave time, and when home after a wait.
      show_drop: iso(dropLeave ?? new Date(trip.drop_leave_at)), show_pick: iso(pickLeave ?? new Date(trip.pick_leave_at)),
      home: w.wait ? new Date(end + trip.drive_min * MIN).toISOString() : null,
    };
  }
  return out;
}

/** The assign_trips choice for an option: owner, each leg's way and adult, the wait, leave times. */
export function choiceFor(tripId, way, times, option, messageId) {
  const dA = needsAdult(way.drop); const pA = needsAdult(way.pick);
  const owner = dA ? option.drop_by : pA ? option.pick_by : null;
  const mode = owner ? 'adult' : way.drop; // no adult leg: the trip goes by its drop-off's way
  const ownerWay = owner ? 'car' : way.drop;
  const legMode = (m) => (m === ownerWay ? null : m === 'car' ? null : m);
  const c = {
    trip: tripId, mode, ...(owner ? { person: owner } : {}),
    drop_mode: legMode(way.drop), pick_mode: legMode(way.pick), wait: !!way.wait,
    drop_person: dA && option.drop_by !== owner ? option.drop_by : null,
    pick_person: pA && option.pick_by !== owner ? option.pick_by : null,
    drop_leave: times.drop_leave, drop_send: times.drop_send, pick_leave: times.pick_leave, pick_send: times.pick_send,
    pick_note: way.wait ? 'you wait there' : null,
  };
  if (messageId) c.message = messageId;
  return c;
}

/** One line for an option: "John drives there (leave 09:04), waits there, picks up at 11:30 (home ~11:46)". */
export function optionText(trip, way, times, option, nameOf, tz) {
  const hm = (iso) => localParts(tz, new Date(iso)).time;
  const a = option.drop_by ? nameOf(option.drop_by) : null; const b = option.pick_by ? nameOf(option.pick_by) : null;
  const dropOn = trip.drop_needed !== false; const pickOn = trip.pick_needed !== false;
  const drop = !dropOn ? 'no drop-off'
    : way.drop === 'car' ? `${a} drives there (leave ${hm(times.show_drop)})`
      : way.drop === 'walk' ? `${a} walks there (leave ${hm(times.show_drop)})`
        : way.drop === 'taxi' ? `taxi there (book ${hm(times.show_drop)})` : `public transport there (leave ${hm(times.show_drop)})`;
  const same = a && b && a === b;
  const pick = !pickOn ? 'no pick-up'
    : way.wait ? `waits there, picks up at ${hm(trip.pick_at ?? trip.event_end)} (home ~${hm(times.home)})`
      : way.pick === 'car' ? `${same ? 'drives back' : `${b} picks up`} (leave ${hm(times.show_pick)})`
        : way.pick === 'walk' ? `${same ? 'walks back' : `${b} walks back`} (leave ${hm(times.show_pick)})`
          : way.pick === 'taxi' ? `taxi back (book ${hm(times.show_pick)})` : `public transport back (leave ${hm(times.show_pick)})`;
  const line = `${drop}, ${pick}`;
  return line[0].toUpperCase() + line.slice(1);
}

/** Short label of an adult for buttons. */
export const firstName = (a) => String(a?.display_name ?? 'Adult').split(' ')[0].slice(0, 20);
