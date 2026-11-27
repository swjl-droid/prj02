// The scheduler's work for one family, once a minute (ADR-02; decision 'US-3 release-1 slice').
//   1. scan (every scan_minutes): calendar events from now to the end of the day after tomorrow
//      become trips, with drive time (saved place, OneMap, or the family's estimate) and leave times
//   2. plan: open trips of today, and of tomorrow from plan_time (19:00), get a 'who takes it?'
//      message for each adult; two trips that need the one car at once get a clash message instead
//   3. send: due messages go out once; nothing is sent in quiet hours (held messages go out at the
//      end of quiet hours if still useful)
// The job store (lib/db.js jobStoreFor) reaches only the family the job was opened for.

import { localParts, addDays, isoAt } from '../calendar/dates.js';
import { isActivity, placeKey, leaveTimes, sendTime, inQuiet, findClashes, clashOptions, tomorrowOf } from './plan.js';
import { planMessage, clashMessage, reminderMessage } from './messages.js';

const MIN = 60_000;

async function driveMinutes(location, fam, places, deps, note) {
  const s = fam.settings;
  if (!location) return { min: s.default_drive_min, source: 'estimate' };
  const key = placeKey(location);
  const saved = places.get(key);
  if (saved) return { min: saved.drive_min, source: saved.source };
  // OneMap only for a Singapore family with a home postal code, and a place found in Singapore.
  if (fam.country !== 'SG' || !fam.home || !deps.onemap) return { min: s.default_drive_min, source: 'estimate' };
  try {
    const to = await deps.onemap.find(location);
    if (!to) return { min: s.default_drive_min, source: 'estimate' };
    const min = await deps.onemap.driveMinutes(fam.home, to);
    await deps.job.savePlace(key, to.lat, to.lng, min, 'onemap');
    places.set(key, { drive_min: min, source: 'onemap' });
    return { min, source: 'onemap' };
  } catch (e) {
    note.push(`onemap:${e.type ?? 'error'}`);
    return { min: s.default_drive_min, source: 'estimate' };
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
  const events = (await deps.google.list(fam.calendar_id, from, to)).filter(isActivity);
  const places = await deps.job.places();
  const kept = [];
  for (const ev of events) {
    const d = await driveMinutes(ev.location, fam, places, deps, note);
    const lt = leaveTimes(ev.start.dateTime, ev.end.dateTime, d.min, s);
    const id = await deps.job.upsertTrip({
      event_id: ev.id, start: ev.start.dateTime, end: ev.end.dateTime, title: ev.summary || '(no title)',
      location: ev.location ?? null, drive_min: d.min, drive_source: d.source,
      drop_leave: lt.dropLeave, pick_leave: lt.pickLeave,
      drop_send: sendTime(lt.dropLeave, s, tz), pick_send: sendTime(lt.pickLeave, s, tz),
    });
    kept.push(id);
  }
  const cancelled = await deps.job.cancelMissing(from, to, kept);
  await deps.job.markScan(fam.home?.lat ?? null, fam.home?.lng ?? null);
  return { events: events.length, cancelled, note };
}

/** Queues today's and (from plan_time) tomorrow's 'who takes it?' and clash messages. */
export async function plan(fam, deps, now) {
  const s = fam.settings; const tz = fam.time_zone;
  const local = localParts(tz, now);
  const tomorrow = tomorrowOf(now, tz);
  const askTomorrow = local.time >= String(s.plan_time).slice(0, 5);
  const until = isoAt(addDays(local.date, askTomorrow ? 2 : 1), '00:00', tz);
  const trips = (await deps.job.trips(now.toISOString(), until)).filter((t) => t.status !== 'cancelled');
  const sendAt = inQuiet(now, s, tz) ? null : now; // never queue into quiet hours
  if (!sendAt) return { plans: 0, clashes: 0 };
  const adults = fam.adults.filter((a) => a.chat);
  let plans = 0; let clashes = 0;
  const inClash = new Set();
  const driver = fam.adults.find((a) => a.can_drive) ?? null;
  for (const pair of findClashes(trips, s.cars)) {
    const [a, b] = pair[0].event_start <= pair[1].event_start ? pair : [pair[1], pair[0]];
    inClash.add(a.id); inClash.add(b.id);
    const payload = { trips: [a.id, b.id], options: clashOptions([a, b], driver), driver: driver?.display_name?.split(' ')[0] ?? null };
    for (const p of adults) if (await deps.job.queue(a.id, 'clash', p.person_id, sendAt, payload)) clashes++;
  }
  for (const t of trips) {
    if (t.status !== 'open' || inClash.has(t.id)) continue;
    if (Date.parse(t.drop_leave_at) < now.getTime()) continue; // too late to ask
    const day = localParts(tz, new Date(t.event_start)).date;
    if (day !== local.date && !(askTomorrow && day === tomorrow)) continue;
    for (const p of adults) if (await deps.job.queue(t.id, 'plan', p.person_id, sendAt, {})) plans++;
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
      reply = planMessage(t, fam.adults, tz, day);
    } else if (m.kind === 'clash') {
      const [a, b] = await Promise.all(m.payload.trips.map((id) => deps.job.trip(id)));
      if (!a || !b) { await deps.job.markFailed(m.id); continue; }
      reply = clashMessage(m.id, [a, b], m.payload.driver, tz);
    } else {
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
