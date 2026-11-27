// Chained trips (prj02-R1 US-8, design fix 1 of Hub row 106): one adult and one car do both
// activities of a clash - the drop-offs one after the other, then the pick-ups one after the other,
// waiting at a place when the next pick-up is there. Pure functions: the code does every sum.
//
//   leave home   = early enough for both: first start - buffer - drive there, and second start -
//                  buffer - (drive there + stop + drive between)  (or the adult's own leave time)
//   between      = OneMap drive time between the two places (else the family's car estimate)
//   pick-ups     = the one that ends first, then the other; the adult waits where the last
//                  drop-off was when the first pick-up is there (as John: "waits at Acro")
//
// Plain English: like planning a school run with two stops on a map, and checking every arrival
// against the clock before offering it.

const MIN = 60_000;
const t = (iso) => Date.parse(iso);

/**
 * Returns null when no order works, else { order: [first, second], leave, legs: Map(tripId ->
 * {drop_leave, drop_note, pick_leave, pick_note}), home, lines } with times as Dates.
 * opts: { leave: Date (adult's own leave time), stopMin (minutes to drop or collect a child),
 *         waitMaxMin (longest wait at a place), lateMin (allowed lateness for a pick-up) }
 */
export function chainPlan(trips, s, betweenMin, opts = {}) {
  const stop = (opts.stopMin ?? 2) * MIN;
  const waitMax = (opts.waitMaxMin ?? 180) * MIN;
  const late = (opts.lateMin ?? 5) * MIN;
  const buf = s.drop_buffer_min * MIN; const pbuf = s.pick_buffer_min * MIN;
  const between = betweenMin * MIN;
  const results = [];
  for (const [x, y] of [[trips[0], trips[1]], [trips[1], trips[0]]]) {
    const dx = x.drive_min * MIN;
    const latest = Math.min(t(x.event_start) - buf - dx, t(y.event_start) - buf - between - stop - dx);
    const leave = opts.leave ? opts.leave.getTime() : latest;
    const atX = leave + dx; const departX = atX + stop; const atY = departX + between;
    if (atX > t(x.event_start) || atY > t(y.event_start)) continue; // someone would be late
    if (opts.dropsOnly) { results.push({ x, y, leave, atX, departX, atY, dropsOnly: true }); continue; }
    // Pick-ups: the one that ends first, then the other.
    const [p, q] = t(x.pick_at ?? x.event_end) <= t(y.pick_at ?? y.event_end) ? [x, y] : [y, x];
    const endP = t(p.pick_at ?? p.event_end); const endQ = t(q.pick_at ?? q.event_end);
    const waits = p.id === y.id && endP - atY <= waitMax; // already there after the last drop-off
    const pickLeaveP = waits ? endP - pbuf : endP - pbuf - p.drive_min * MIN;
    const departP = endP + stop; const atQ = departP + between;
    if (atQ > endQ + late) continue;
    const home = Math.max(atQ, endQ) + stop + q.drive_min * MIN;
    results.push({ x, y, p, q, leave, atX, departX, atY, waits, pickLeaveP, endP, departP, atQ, home, slack: latest - leave });
  }
  if (!results.length) return null;
  // Prefer the order that lets the adult leave latest (or, with their own time, any that works).
  const r = results.sort((a, b) => b.leave - a.leave || (a.home ?? 0) - (b.home ?? 0))[0];
  const legs = new Map();
  legs.set(r.x.id, { drop_leave: new Date(r.leave), drop_note: `then ${r.y.title.slice(0, 60)}` });
  legs.set(r.y.id, { drop_leave: new Date(r.departX), drop_note: `after ${r.x.title.slice(0, 60)}` });
  if (r.dropsOnly) return { order: [r.x, r.y], leave: new Date(r.leave), atX: new Date(r.atX), atY: new Date(r.atY), legs };
  Object.assign(legs.get(r.p.id), { pick_leave: new Date(r.pickLeaveP), pick_note: r.waits ? 'you wait there' : `then ${r.q.title.slice(0, 60)}` });
  Object.assign(legs.get(r.q.id), { pick_leave: new Date(r.departP), pick_note: `after ${r.p.title.slice(0, 60)}` });
  return { order: [r.x, r.y], picks: [r.p, r.q], leave: new Date(r.leave), atX: new Date(r.atX), atY: new Date(r.atY),
    waits: r.waits, endP: new Date(r.endP), atQ: new Date(r.atQ), home: new Date(r.home), legs };
}

/** One line for a message: "leave 14:45, River 14:54, Dunearn 15:10; wait; Ang 17:00, Cel 17:30, home ~17:50". */
export function chainSummary(c, hm) {
  const short = (tr) => tr.title.split(/\s+-\s+/)[0].slice(0, 30);
  return `leave ${hm(c.leave)}: ${short(c.order[0])} ${hm(c.atX)}, then ${short(c.order[1])} ${hm(c.atY)}; `
    + `${c.waits ? `wait there; ` : ''}pick up ${short(c.picks[0])} ${hm(c.endP)}, then ${short(c.picks[1])} ${hm(c.atQ)}; home ~${hm(c.home)}`;
}

/**
 * Pick-ups only, one adult and one car (US-8): from home to the one that ends first, then on to the
 * other. Returns null when the second would be more than lateMin late, else Map(tripId ->
 * {pick_leave, pick_note}).
 */
export function chainPicks(trips, s, betweenMin, opts = {}) {
  const stop = (opts.stopMin ?? 2) * MIN; const late = (opts.lateMin ?? 5) * MIN;
  const pbuf = s.pick_buffer_min * MIN; const between = betweenMin * MIN;
  const [p, q] = t(trips[0].pick_at ?? trips[0].event_end) <= t(trips[1].pick_at ?? trips[1].event_end) ? trips : [trips[1], trips[0]];
  const endP = t(p.pick_at ?? p.event_end); const endQ = t(q.pick_at ?? q.event_end);
  const departP = endP + stop;
  if (departP + between > endQ + late) return null;
  return new Map([
    [p.id, { pick_leave: new Date(endP - pbuf - p.drive_min * MIN), pick_note: `then ${q.title.slice(0, 60)}` }],
    [q.id, { pick_leave: new Date(departP), pick_note: `after ${p.title.slice(0, 60)}` }],
  ]);
}
