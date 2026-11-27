// Taps on 'who takes it?' and clash messages (prj02-R1 US-3). Any adult of the family may answer;
// the tap is the yes. The database (assign_trips) checks the trip and the person belong to the
// adult's family; buttons carry only ids.
import { assignedReply } from '../trips/messages.js';
import { describeWhen, localParts, addDays, isoAt } from '../calendar/dates.js';

const NOT_DONE = {
  unknown: 'This activity is no longer in the plan (moved or deleted?). Nothing was changed.',
  bad_choice: 'That choice is not possible any more. Nothing was changed.',
  not_adult: 'Only an adult of the family can decide this.',
};

/** 'tr:<trip uuid>:<8 hex of a person | taxi | pub>', 'cl:<message uuid>:<1|2>' or 'hd:<trip uuid>'. */
export async function handleTripButton(action, ctx, store, cfg) {
  // 'hd:<trip>': "Include it" under the warning about an event whose notes looked like an
  // instruction (US-4, AI-L08 case 2). The database checks the trip is this family's.
  const hd = action.match(/^hd:([0-9a-f-]{36})$/);
  if (hd) {
    const r = await store.releaseTrip(hd[1]);
    return [{ text: r?.ok ? 'OK, it is back in the plan: I will ask who takes it as usual.' : NOT_DONE.unknown }];
  }
  let choices;
  const tr = action.match(/^tr:([0-9a-f-]{36}):([0-9a-f]{8}|taxi|pub)$/);
  const cl = action.match(/^cl:([0-9a-f-]{36}):([12])$/);
  if (tr) {
    const [, trip, who] = tr;
    if (who === 'taxi' || who === 'pub') choices = [{ trip, mode: who === 'taxi' ? 'taxi' : 'public' }];
    else {
      const person = (await store.people()).find((p) => p.id.startsWith(who));
      if (!person) return [{ text: NOT_DONE.bad_choice }];
      choices = [{ trip, mode: 'adult', person: person.id }];
    }
  } else if (cl) {
    const payload = await store.clashOptions(cl[1]);
    choices = payload?.options?.[Number(cl[2]) - 1];
    if (!choices) return [{ text: NOT_DONE.unknown }];
  } else {
    return [{ text: NOT_DONE.unknown }];
  }
  const r = await store.assignTrips(choices);
  if (!r?.ok) return [{ text: NOT_DONE[r?.reason] ?? NOT_DONE.unknown }];
  const trips = (await Promise.all(choices.map((c) => store.trip(c.trip)))).filter(Boolean);
  return [{ text: assignedReply(trips, await store.people(), cfg.timeZone ?? 'Asia/Singapore') }];
}

/** "What's on": the Family calendar's events in a range, with who takes each when known. */
export async function whatsOn(req, store, deps, tz, now) {
  const cal = await store.calendar();
  if (!cal) return [{ text: "Your family's calendar is not connected yet. Ask your family admin." }];
  const today = localParts(tz, new Date(now)).date;
  const from = req.dateFrom ?? today;
  const to = req.dateTo && req.dateTo >= from ? req.dateTo : from;
  const startIso = from === today ? new Date(now).toISOString() : isoAt(from, '00:00', tz);
  const endIso = isoAt(addDays(to, 1), '00:00', tz);
  const events = await deps.google.list(cal.external_id, startIso, endIso);
  const trips = await store.trips(isoAt(from, '00:00', tz), endIso);
  const people = await store.people();
  const range = from === to ? describeWhen({ date: from }, null, tz).replace(', all day', '') : `${describeWhen({ date: from }, null, tz).replace(', all day', '')} to ${describeWhen({ date: to }, null, tz).replace(', all day', '')}`;
  if (events.length === 0) return [{ text: `Nothing in the Family calendar for ${range}${from === today ? ' (from now)' : ''}.` }];
  const lines = events.slice(0, 25).map((e) => {
    const t = trips.find((x) => x.event_id === e.id && x.status !== 'cancelled');
    const who = !t ? '' : t.status !== 'assigned' ? ' - who takes it? (not decided)'
      : t.owner_mode === 'taxi' ? ' - taxi' : t.owner_mode === 'public' ? ' - public transport'
      : ` - ${people.find((p) => p.id === t.owner_person_id)?.display_name.split(' ')[0] ?? 'an adult'} takes it`;
    return `- ${describeWhen(e.start, e.end, tz)}: ${e.summary ?? '(no title)'}${e.location ? ` at ${e.location}` : ''}${who}`;
  });
  return [{ text: [`Family calendar, ${range}:`, ...lines, ...(events.length > 25 ? [`...and ${events.length - 25} more.`] : [])].join('\n') }];
}
