// The scheduler's work for one family, once a minute (ADR-02; decision 'US-3 release-1 slice').
//   1. scan (every scan_minutes): calendar events from now to the end of the day after tomorrow
//      become trips, with travel time for the trip's way of travel (saved place, OneMap, or the
//      family's estimate for it) and leave times
//   2. plan: open trips of today, and of tomorrow from plan_time (19:00), get a 'who takes it?'
//      message for each adult; two trips that need the one car at once get a clash message instead
//   3. send: due messages go out once; nothing is sent in quiet hours (held messages go out at the
//      end of quiet hours if still useful)
// The job store (lib/db.js jobStoreFor) reaches only the family the job was opened for.

import { localParts, addDays, isoAt } from '../calendar/dates.js';
import { isActivity, placeKey, placeId, leaveTimes, sendTime, inQuiet, findClashes, clashOptions, tomorrowOf, stays, noLegs } from './plan.js';
import { parseWho } from './who.js';
import { chainPlan, chainSummary } from './chain.js';
import { wayTimes, rankOptions, choiceFor } from './ways.js';
import { planMessage, legacyPlanMessage, clashMessage, reminderMessage, warningMessage, unknownMessage, doubleMessage } from './messages.js';
import { looksLikeInstruction } from '../bot/guard.js';
import { settings } from '../config.js';

const MIN = 60_000;

// Way of travel of a trip: an open trip or one an adult takes goes by car (decision 'US-3
// release-1 slice': the clash check is about the one car); taxi and public transport after a tap.
export const modeOf = (trip) => (trip?.owner_mode === 'taxi' ? 'taxi' : trip?.owner_mode === 'public' ? 'public' : 'car');

/**
 * Travel minutes for one trip (decision 27/11/2026, Hub row 277): the family's row for the way of
 * travel says which OneMap route to ask and the estimate when OneMap cannot tell; its lead time
 * (taxi booking) is added. Saved places keep one time per place and route.
 */
export async function travelMinutes(location, cfg, fam, places, deps, note, at) {
  const estimate = { min: cfg.estimate_min + cfg.lead_min, source: 'estimate' };
  if (!location) return estimate;
  const key = placeKey(location);
  const saved = places.get(`${cfg.route}|${key}`);
  if (saved) return { min: saved.drive_min + cfg.lead_min, source: saved.source };
  // OneMap only for a Singapore family with a home postal code, and a place found in Singapore.
  if (fam.country !== 'SG' || !fam.home || !deps.onemap) return estimate;
  try {
    const known = [...places.entries()].find(([k, v]) => k.endsWith(`|${key}`) && v.lat != null);
    const to = known ? { lat: known[1].lat, lng: known[1].lng } : await deps.onemap.find(location);
    if (!to) { note.push('onemap:not_found'); return estimate; }
    const min = await deps.onemap.routeMinutes(fam.home, to, cfg.route, at);
    await deps.job.savePlace(key, to.lat, to.lng, min, 'onemap', cfg.route);
    places.set(`${cfg.route}|${key}`, { drive_min: min, source: 'onemap', lat: to.lat, lng: to.lng });
    return { min: min + cfg.lead_min, source: 'onemap' };
  } catch (e) {
    note.push(`onemap:${e.type ?? 'error'}`);
    return estimate;
  }
}

export async function scan(fam, deps, now) {
  const s = fam.settings; const tz = fam.time_zone; const note = [];
  // Home coordinates, once (from the postal code).
  if (!fam.home && fam.country === 'SG' && s.home_postal && deps.onemap) {
    try {
      const h = await deps.onemap.find(s.home_postal);
      if (h) fam.home = h;
    } catch (e) { note.push(`onemap:${e.type ?? 'error'}`); }
  }
  const today = localParts(tz, now).date;
  const from = now.toISOString();
  const to = isoAt(addDays(today, 3), '00:00', tz);
  // The stay rule also looks at today's events that already ended (a school day that ended at 15:00
  // means no drop-off for violin at 15:10); only events still to come become or update trips.
  const all = (await deps.google.list(fam.calendar_id, isoAt(today, '00:00', tz), to)).filter(isActivity);
  const events = all.filter((e) => Date.parse(e.end.dateTime) > now.getTime());
  const places = await deps.job.places();
  // Trips of today too: an activity under way keeps its owner's choices (e.g. a pick-up time).
  const known = await deps.job.trips(isoAt(today, '00:00', tz), to);
  const existing = new Map(known.map((t) => [`${t.event_id}|${new Date(t.event_start).getTime()}`, t]));
  const kept = [];
  // US-7: who each event is for, by the family's convention and children (none listed: as before).
  const whoCtx = { convention: fam.convention, children: fam.children ?? [], adults: fam.adults };
  const who = new Map(all.map((e) => [e.id, parseWho(e.summary, whoCtx)]));
  const childrenOf = (e) => { const w = who.get(e.id); return w && w.state !== 'legacy' ? w.childIds : null; };
  const stay = stays(all, settings.stay_gap_minutes ?? 15, childrenOf); // US-6 stay rule, per child (US-7)
  const idOf = new Map(); // event id -> trip id, for the checks after the loop
  // Children being typed in one by one: no "who is X?" for a few minutes after the list changed.
  const lastChildChange = Math.max(0, ...(fam.children ?? []).map((c) => Date.parse(c.updated_at ?? 0) || 0));
  const childrenSettling = now.getTime() - lastChildChange < (settings.children_settle_minutes ?? 10) * MIN;
  const askedNames = new Set((await deps.job.askedNames()).map((n) => n.toLowerCase())); // names already asked about
  for (const ev of events) {
    const w = who.get(ev.id);
    if (w.state === 'none') continue; // an adult's own event (no child named): not a trip
    const old = existing.get(`${ev.id}|${new Date(ev.start.dateTime).getTime()}`);
    const cfg = fam.modes?.[modeOf(old)] ?? fam.modes?.car;
    if (!cfg) { note.push('travel_mode:missing'); if (old) kept.push(old.id); continue; } // keep, never cancel
    const d = await travelMinutes(ev.location, cfg, fam, places, deps, note, ev.start.dateTime);
    // A pick-up time set by an adult's own plan (US-6) moves the pick-up leave time.
    const pickAt = old?.pick_at ? new Date(old.pick_at).toISOString() : null;
    const lt = leaveTimes(ev.start.dateTime, ev.end.dateTime, d.min, s, pickAt);
    // Leave times an adult or a chained plan set (US-8) are kept as they are.
    if (old?.drop_leave_set) lt.dropLeave = new Date(old.drop_leave_set);
    if (old?.pick_leave_set) lt.pickLeave = new Date(old.pick_leave_set);
    const st = stay.get(ev.id) ?? { drop: true, pick: true };
    const id = await deps.job.upsertTrip({
      event_id: ev.id, start: ev.start.dateTime, end: ev.end.dateTime, title: ev.summary || '(no title)',
      location: ev.location ?? null, drive_min: d.min, drive_source: d.source,
      drop_leave: lt.dropLeave, pick_leave: lt.pickLeave,
      drop_send: sendTime(lt.dropLeave, s, tz), pick_send: sendTime(lt.pickLeave, s, tz),
      drop_needed: st.drop, pick_needed: st.pick,
      child_ids: w.childIds, who_state: w.state === 'unknown' ? 'unknown' : 'child', unknown_name: w.unknownName ?? null,
    });
    kept.push(id); idOf.set(ev.id, id);
    // A name the family has not listed: asked once per name (US-7), never while it is answered.
    if (w.state === 'unknown' && old?.who_state !== 'none_by_adult' && !askedNames.has(w.unknownName.toLowerCase()) && !childrenSettling) {
      askedNames.add(w.unknownName.toLowerCase());
      for (const a of fam.adults.filter((x) => x.chat)) await deps.job.queue(id, 'unknown', a.person_id, now, {});
    }
    // AI-L08 case 2: notes that try to instruct the bot. Nothing here acts on event text; the event
    // is held out of the plan and each adult is warned once, until an adult taps "Include it".
    if ((old?.hold_state ?? 'none') === 'none' && looksLikeInstruction(ev) && await deps.job.holdTrip(id)) {
      note.push('guard:held');
      for (const a of fam.adults.filter((x) => x.chat)) await deps.job.queue(id, 'warning', a.person_id, now, {});
    }
  }
  // One child in two places at once (US-7): flagged once as a likely calendar mistake.
  const timed = events.filter((e) => (who.get(e.id)?.childIds ?? []).length && placeId(e.location));
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i]; const b = timed[j];
      const both = who.get(a.id).childIds.filter((c) => who.get(b.id).childIds.includes(c));
      const overlapping = Date.parse(a.start.dateTime) < Date.parse(b.end.dateTime) && Date.parse(b.start.dateTime) < Date.parse(a.end.dateTime);
      if (!both.length || !overlapping || placeId(a.location) === placeId(b.location)) continue;
      if (!idOf.has(a.id) || !idOf.has(b.id)) continue;
      for (const ad of fam.adults.filter((x) => x.chat)) await deps.job.queue(idOf.get(b.id), 'double', ad.person_id, now, { other: idOf.get(a.id) });
    }
  }
  const cancelled = await deps.job.cancelMissing(from, to, kept);
  await deps.job.markScan(fam.home?.lat ?? null, fam.home?.lng ?? null);
  return { events: events.length, cancelled, note };
}

/**
 * Drive minutes between two trips' places (US-8): saved once per pair of places (in the places
 * table, key 'a>b'), from OneMap with both places' saved coordinates; else the family's car estimate.
 */
export async function betweenMinutes(a, b, fam, deps) {
  const pa = placeId(a.location); const pb = placeId(b.location);
  const est = { min: fam.modes?.car?.estimate_min ?? 30, source: 'estimate' };
  if (!pa || !pb) return est;
  if (pa === pb) return { min: 0, source: 'same place' };
  const key = [pa, pb].sort().join('>');
  const places = await deps.job.places();
  const saved = places.get(`drive|${key}`);
  if (saved) return { min: saved.drive_min, source: saved.source };
  const ca = places.get(`drive|${placeKey(a.location)}`); const cb = places.get(`drive|${placeKey(b.location)}`);
  if (!deps.onemap || ca?.lat == null || cb?.lat == null) return est;
  try {
    const min = await deps.onemap.routeMinutes({ lat: ca.lat, lng: ca.lng }, { lat: cb.lat, lng: cb.lng }, 'drive');
    await deps.job.savePlace(key, null, null, min, 'onemap', 'drive');
    return { min, source: 'onemap' };
  } catch {
    return est;
  }
}

/** The settings the ways of a trip use (US-9): the family's buffers and quiet hours, the bot's list. */
const waySettings = (s) => ({ ...s, max_options: settings.max_options ?? 3, history_count: settings.history_count ?? 4,
  wait_max_minutes: settings.wait_max_minutes ?? 120, walk_max_minutes: settings.walk_max_minutes ?? 15 });

/**
 * The ways of one trip (US-9): minutes by taxi, public transport and on foot (saved places, OneMap,
 * else the family's estimate; walking only from OneMap), the times of each way, and the options in
 * order (past choices of the same activity, then the rules). Returns { ways, top }.
 */
export async function tripWays(t, fam, deps, ctx) {
  const s = waySettings(fam.settings); const tz = fam.time_zone;
  const minutes = { car: t.drive_min };
  for (const mode of ['taxi', 'public']) {
    if (fam.modes?.[mode]) minutes[mode] = (await travelMinutes(t.location, fam.modes[mode], fam, ctx.places, deps, ctx.note, t.event_start)).min;
  }
  const walk = await travelMinutes(t.location, { route: 'walk', estimate_min: Number.NaN, lead_min: 0 }, fam, ctx.places, deps, ctx.note, t.event_start);
  minutes.walk = Number.isFinite(walk.min) ? walk.min : null;
  const list = settings.trip_ways ?? [];
  const times = wayTimes(t, list, minutes, s, tz);
  // Walking is a way only when it takes walk_max_minutes or less (Hub row 308).
  const walkOk = minutes.walk != null && minutes.walk <= s.walk_max_minutes;
  const ways = list.filter((w) => times[w.id] && (walkOk || (w.drop !== 'walk' && w.pick !== 'walk'))).map((w) => ({ ...w, times: times[w.id] }));
  const adults = fam.adults.filter((a) => a.can_drive !== false);
  const { top } = rankOptions(t, { ways, adults: adults.length ? adults : fam.adults, history: ctx.history, minutes, s });
  return { ways, top };
}

/** Queues today's and (from plan_time) tomorrow's 'who takes it?' and clash messages. */
export async function plan(fam, deps, now) {
  const s = fam.settings; const tz = fam.time_zone;
  const local = localParts(tz, now);
  const tomorrow = tomorrowOf(now, tz);
  const askTomorrow = local.time >= String(s.plan_time).slice(0, 5);
  const until = isoAt(addDays(local.date, askTomorrow ? 2 : 1), '00:00', tz);
  const trips = (await deps.job.trips(now.toISOString(), until))
    .filter((t) => t.status !== 'cancelled' && t.hold_state !== 'held' // held: out of the plan (US-4)
      && (t.who_state ?? 'child') === 'child'); // unknown names and adults' events: not planned (US-7)
  const sendAt = inQuiet(now, s, tz) ? null : now; // never queue into quiet hours
  if (!sendAt) return { plans: 0, clashes: 0 };
  const adults = fam.adults.filter((a) => a.chat);
  let plans = 0; let clashes = 0;
  const inClash = new Set();
  const driver = fam.adults.find((a) => a.can_drive) ?? null;
  // US-9: past trips of the family (for the usual choice per activity), places and notes, once.
  const ctx = { places: await deps.job.places(), note: [], history: null };
  const history = async () => (ctx.history ??= await deps.job.trips(new Date(now.getTime() - (settings.history_days ?? 180) * 1440 * MIN).toISOString(), now.toISOString()));
  for (const pair of findClashes(trips, s.cars)) {
    const [a, b] = pair[0].event_start <= pair[1].event_start ? pair : [pair[1], pair[0]];
    inClash.add(a.id); inClash.add(b.id);
    const queued = await deps.job.queuedFor(a.id, 'clash');
    const waiting = adults.filter((p) => !queued.has(p.person_id));
    if (!waiting.length) continue; // already asked: nothing to work out
    const payload = { trips: [a.id, b.id], options: clashOptions([a, b], driver), driver: driver?.display_name?.split(' ')[0] ?? null };
    // US-8: option 3, the driver does both in a row (one car, two stops), when every arrival fits.
    if (driver) {
      const between = await betweenMinutes(a, b, fam, deps);
      payload.between_min = between.min;
      const c = chainPlan([a, b], s, between.min, { stopMin: settings.chain_stop_minutes, waitMaxMin: settings.chain_wait_max_minutes, lateMin: settings.chain_late_minutes });
      if (c) {
        payload.options.push([a, b].map((tr) => {
          const l = c.legs.get(tr.id);
          return { trip: tr.id, mode: 'adult', person: driver.person_id, drop_leave: l.drop_leave.toISOString(), drop_send: sendTime(l.drop_leave, s, tz).toISOString(),
            drop_note: l.drop_note, pick_leave: l.pick_leave.toISOString(), pick_send: sendTime(l.pick_leave, s, tz).toISOString(), pick_note: l.pick_note };
        }));
        payload.chain = chainSummary(c, (d) => localParts(tz, d).time) + (between.source === 'estimate' ? ' (drive between est.)' : '');
      }
    }
    // US-9: "Other ways…" under a clash decides each activity on its own, with its own ways.
    ctx.history = await history();
    payload.ways_by_trip = [];
    for (const tr of [a, b]) payload.ways_by_trip.push({ trip: tr.id, ways: (await tripWays(tr, fam, deps, ctx)).ways });
    for (const p of waiting) if (await deps.job.queue(a.id, 'clash', p.person_id, sendAt, payload)) clashes++;
  }
  for (const t of trips) {
    if (t.status !== 'open' || inClash.has(t.id) || noLegs(t)) continue; // no drive needed: nothing to ask
    const firstLeave = t.drop_needed !== false ? t.drop_leave_at : t.pick_leave_at;
    if (Date.parse(firstLeave) < now.getTime()) continue; // too late to ask
    const day = localParts(tz, new Date(t.event_start)).date;
    if (day !== local.date && !(askTomorrow && day === tomorrow)) continue;
    const queued = await deps.job.queuedFor(t.id, 'plan');
    const waiting = adults.filter((p) => !queued.has(p.person_id));
    if (!waiting.length) continue; // already asked: nothing to work out
    ctx.history = await history();
    const { ways, top } = await tripWays(t, fam, deps, ctx);
    const payload = { trips: [t.id], ways, top,
      options: top.map((o) => [choiceFor(t.id, ways.find((w) => w.id === o.way), ways.find((w) => w.id === o.way).times, o)]) };
    for (const p of waiting) if (await deps.job.queue(t.id, 'plan', p.person_id, sendAt, payload)) plans++;
  }
  return { plans, clashes };
}

/**
 * Claims the family's due messages (each once) and writes their texts. The caller sends them after
 * the transaction commits, so a rolled-back tick never leaves a message sent but unrecorded.
 */
export async function collect(fam, deps, now) {
  const s = fam.settings; const tz = fam.time_zone;
  if (inQuiet(now, s, tz)) return [];
  const due = await deps.job.claimDue(20);
  const outbox = [];
  for (const m of due) {
    const person = fam.adults.find((a) => a.person_id === m.person_id);
    const t = await deps.job.trip(m.trip_id);
    if (!person?.chat || !t || t.status === 'cancelled') { await deps.job.markFailed(m.id); continue; }
    let reply;
    if (m.kind === 'plan') {
      const day = localParts(tz, new Date(t.event_start)).date === localParts(tz, now).date ? 'Today' : 'Tomorrow';
      reply = m.payload?.ways ? planMessage(m.id, t, m.payload, fam.adults, tz, day) : legacyPlanMessage(t, fam.adults, tz, day);
    } else if (m.kind === 'unknown') {
      if (t.who_state !== 'unknown') { await deps.job.markFailed(m.id); continue; } // already answered
      reply = unknownMessage(t, fam.children ?? [], tz);
    } else if (m.kind === 'double') {
      const other = await deps.job.trip(m.payload?.other);
      if (!other || other.status === 'cancelled') { await deps.job.markFailed(m.id); continue; }
      reply = doubleMessage(t, other, tz);
    } else if (m.kind === 'warning') {
      if (t.hold_state !== 'held') { await deps.job.markFailed(m.id); continue; } // already included
      reply = warningMessage(t, tz);
    } else if (m.kind === 'clash') {
      const [a, b] = await Promise.all(m.payload.trips.map((id) => deps.job.trip(id)));
      if (!a || !b) { await deps.job.markFailed(m.id); continue; }
      reply = clashMessage(m.id, [a, b], m.payload.driver, tz, m.payload.chain ?? null);
    } else {
      const unneeded = m.kind === 'drop' ? (t.drop_needed === false || t.drop_mode === 'none') : (t.pick_needed === false || t.pick_mode === 'none');
      if (unneeded) { await deps.job.markFailed(m.id); continue; } // stay rule or own plan: leg not needed
      const leave = Date.parse(m.kind === 'drop' ? t.drop_leave_at : t.pick_leave_at);
      if (leave < now.getTime() - 30 * MIN) { await deps.job.markFailed(m.id); continue; } // too late to help
      const early = leave - now.getTime() > 60 * MIN;
      const tomorrow = localParts(tz, new Date(leave)).date > localParts(tz, now).date;
      reply = reminderMessage(m.kind, t, tz, { early, tomorrow });
    }
    outbox.push({ id: m.id, kind: m.kind, chat: person.chat, reply });
  }
  return outbox;
}

/** One family's tick (inside its job transaction): returns what to send after commit. */
export async function tickFamily(fam, deps, now) {
  const scanEvery = fam.settings.scan_minutes * MIN;
  const last = fam.settings.last_scan_at ? Date.parse(fam.settings.last_scan_at) : 0;
  const scanned = now.getTime() - last >= scanEvery - 5000 ? await scan(fam, deps, now) : null;
  const planned = await plan(fam, deps, now);
  const outbox = await collect(fam, deps, now);
  return { scanned, planned, outbox };
}
