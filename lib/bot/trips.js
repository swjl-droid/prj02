// Taps on 'who takes it?' and clash messages (prj02-R1 US-3). Any adult of the family may answer;
// the tap is the yes. The database (assign_trips) checks the trip and the person belong to the
// adult's family; buttons carry only ids.
import { assignedReply } from '../trips/messages.js';
import { placeLabel } from '../trips/plan.js';
import { describeWhen, localParts, addDays, isoAt } from '../calendar/dates.js';

const NOT_DONE = {
  unknown: 'This activity is no longer in the plan (moved or deleted?). Nothing was changed.',
  bad_choice: 'That choice is not possible any more. Nothing was changed.',
  not_adult: 'Only an adult of the family can decide this.',
};

/** 'tr:<trip>:<8 hex of a person | taxi | pub>', 'cl:<message>:<1|2|3>', 'hd:<trip>', 'op:<message>', 'pl:<plan>:<y|n>', 'ca:<trip>:<8 hex of a child>' or 'cn:<trip>'. */
export async function handleTripButton(action, ctx, store, cfg) {
  // 'hd:<trip>': "Include it" under the warning about an event whose notes looked like an
  // instruction (US-4, AI-L08 case 2). The database checks the trip is this family's.
  // 'ca:<trip>:<8 hex of a child>' / 'cn:<trip>': answer to "who is X?" (US-7).
  const ca = action.match(/^ca:([0-9a-f-]{36}):([0-9a-f]{8})$/);
  const cn = action.match(/^cn:([0-9a-f-]{36})$/);
  if (ca || cn) {
    let child = null;
    if (ca) {
      child = (await store.children()).find((c) => c.id.startsWith(ca[2]));
      if (!child) return [{ text: NOT_DONE.bad_choice }];
    }
    const r = await store.resolveUnknown((ca ?? cn)[1], child?.id ?? null);
    if (!r?.ok) return [{ text: r?.reason === 'bad_child' ? 'That child already has 10 names. Change them with /children.' : NOT_DONE.unknown }];
    return [{ text: child ? `OK: that name is now a nickname of ${child.name}. I plan the event at the next check.` : "OK: an adult's own event, not a trip. I leave it out of the plan." }];
  }
  // 'op:<clash>': "My own plan…" (US-6): the adult's next message is read as their plan.
  const op = action.match(/^op:([0-9a-f-]{36})$/);
  if (op) {
    const r = await store.planAwait(op[1], cfg.planValidMinutes ?? 30);
    if (!r?.ok) return [{ text: NOT_DONE.unknown }];
    return [{ text: 'Tell me your plan in one message, for example "no drop-off needed, one pick-up at 6pm" or "I take violin, tennis by taxi". I will show it to you before anything changes.' }];
  }
  // 'pl:<plan>:y|n': Yes / No under the plan shown back. Only the adult who wrote it decides.
  const pl = action.match(/^pl:([0-9a-f-]{36}):([yn])$/);
  if (pl) {
    const r = await store.planDecide(pl[1], pl[2] === 'y');
    if (!r?.ok) {
      const why = { not_yours: 'Only the adult who wrote this plan can apply it.', expired: "This plan has timed out. Tap 'My own plan…' again.",
        applied: 'This plan is already applied.', declined: 'This plan was not applied.' }[r?.reason];
      return [{ text: why ?? NOT_DONE.unknown }];
    }
    return [{ text: r.status === 'applied' ? 'Done: your plan is applied. Reminders come only for the drop-offs and pick-ups in it.' : 'OK, nothing was changed.' }];
  }
  const hd = action.match(/^hd:([0-9a-f-]{36})$/);
  if (hd) {
    const r = await store.releaseTrip(hd[1]);
    return [{ text: r?.ok ? 'OK, it is back in the plan: I will ask who takes it as usual.' : NOT_DONE.unknown }];
  }
  let choices;
  const tr = action.match(/^tr:([0-9a-f-]{36}):([0-9a-f]{8}|taxi|pub)$/);
  const cl = action.match(/^cl:([0-9a-f-]{36}):([123])$/);
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
    return `- ${describeWhen(e.start, e.end, tz)}: ${e.summary ?? '(no title)'}${e.location ? ` at ${placeLabel(e.location)}` : ''}${who}`;
  });
  return [{ text: [`Family calendar, ${range}:`, ...lines, ...(events.length > 25 ? [`...and ${events.length - 25} more.`] : [])].join('\n') }];
}
