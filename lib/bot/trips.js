// Taps on 'who takes it?' and clash messages (prj02-R1 US-3). Any adult of the family may answer;
// the tap is the yes. The database (assign_trips) checks the trip and the person belong to the
// adult's family; buttons carry only ids.
import { assignedReply, chosenMessage, mainButtons, tripButtons, wayButtons, whoButtons, clashLines, planLines } from '../trips/messages.js';
import { choiceFor, optionText, firstName } from '../trips/ways.js';
import { placeLabel } from '../trips/plan.js';
import { describeWhen, localParts, addDays, isoAt } from '../calendar/dates.js';

const NOT_DONE = {
  unknown: 'This activity is no longer in the plan (moved or deleted?). Nothing was changed.',
  bad_choice: 'That choice is not possible any more. Nothing was changed.',
  not_adult: 'Only an adult of the family can decide this.',
};
const hex = (id) => (id ? id.slice(0, 8) : '-');

/**
 * Applies a choice (US-9): the tapped message then shows what was chosen, with no options left.
 * A second tap, or another adult's tap on their copy, changes nothing ('already').
 */
async function apply(choices, messageId, ctx, store, cfg, next = null, line = null) {
  const tz = cfg.timeZone ?? 'Asia/Singapore';
  const now = cfg.now?.() ?? new Date();
  const r = await store.assignTrips(choices);
  const people = await store.people();
  if (r?.reason === 'already') {
    const by = people.find((p) => p.id === r.by)?.display_name?.split(' ')[0] ?? 'another adult';
    const at = r.at ? localParts(tz, new Date(r.at)).time : '';
    return [
      { edit: 'buttons', buttons: messageId ? [[{ label: 'My own plan…', action: `op:${messageId}` }]] : [] },
      { text: `Already chosen by ${by}${at ? ` at ${at}` : ''}. Nothing changed. To change it, tap 'My own plan…'.` },
    ];
  }
  if (!r?.ok) return [{ text: NOT_DONE[r?.reason] ?? NOT_DONE.unknown }];
  const trips = (await Promise.all(choices.map((c) => store.trip(c.trip)))).filter(Boolean);
  if (!messageId) { // a message of release 1 ('tr:' buttons): its buttons go too
    const by = people.find((p) => p.id === ctx.person_id)?.display_name?.split(' ')[0];
    return [{ edit: true, text: `${by ? `Chosen by ${by} at ${localParts(tz, now).time}:\n` : ''}${assignedReply(trips, people, tz)}`, buttons: [] }];
  }
  const done = chosenMessage(messageId, trips, people, tz, ctx.person_id, now, line);
  if (next) { // a clash decided one activity at a time: the other one is next
    done.text = `${done.text.split('\n').slice(0, -1).join('\n')}\nNow ${next.trip.title}: how?`;
    done.buttons = wayButtons(messageId, next.k, next.ways);
  }
  return [done];
}

/**
 * 'tr:<trip>:<8 hex of a person | taxi | pub>' (release 1), 'cl:<message>:<n>' (an option),
 * 'ow:<message>[:<activity>[:<way>[:<drop adult>:<pick adult>]]]' (other ways: which activity, how,
 * who), 'ob:<message>' (back), 'hd:<trip>', 'op:<message>', 'pl:<plan>:<y|n>',
 * 'ca:<trip>:<8 hex of a child>' or 'cn:<trip>'.
 */
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
  // 'ob:<message>': back to the message's own buttons.
  const ob = action.match(/^ob:([0-9a-f-]{36})$/);
  if (ob) {
    const payload = await store.clashOptions(ob[1]);
    if (!payload) return [{ text: NOT_DONE.unknown }];
    return [{ edit: 'buttons', buttons: mainButtons(ob[1], (payload.options ?? []).length) }];
  }
  // 'ow:...': other ways (US-9) - which activity (a clash), how, then who; then the choice.
  const ow = action.match(/^ow:([0-9a-f-]{36})(?::([0-9]))?(?::([0-9]{1,2}))?(?::([0-9a-f]{8}|-):([0-9a-f]{8}|-))?$/);
  if (ow) {
    const [, m, k, i, d, p] = ow;
    const payload = await store.clashOptions(m);
    if (!payload) return [{ text: NOT_DONE.unknown }];
    const sets = payload.kind === 'clash' ? (payload.ways_by_trip ?? []) : [{ trip: payload.trips?.[0], ways: payload.ways ?? [] }];
    if (!sets.length || !sets[0].trip) return [{ text: NOT_DONE.unknown }];
    if (k === undefined) {
      if (sets.length > 1) return [{ edit: 'buttons', buttons: tripButtons(m, await Promise.all(sets.map((x) => store.trip(x.trip)))) }];
      return [{ edit: 'buttons', buttons: wayButtons(m, 0, sets[0].ways) }];
    }
    const set = sets[Number(k)];
    if (!set) return [{ text: NOT_DONE.unknown }];
    if (i === undefined) return [{ edit: 'buttons', buttons: wayButtons(m, Number(k), set.ways) }];
    const way = set.ways[Number(i)];
    if (!way) return [{ text: NOT_DONE.unknown }];
    const { opts, buttons } = whoButtons(m, Number(k), Number(i), way, await store.people());
    let opt;
    if (d === undefined) {
      if (opts.length !== 1) return [{ edit: 'buttons', buttons }];
      [opt] = opts;
    } else {
      opt = opts.find((o) => hex(o.drop_by) === d && hex(o.pick_by) === p);
      if (!opt) return [{ text: NOT_DONE.bad_choice }];
    }
    // A clash decided one activity at a time: after this one, the other one if still open.
    let next = null;
    if (sets.length > 1) {
      const k2 = Number(k) === 0 ? 1 : 0;
      const other = await store.trip(sets[k2].trip);
      if (other && other.status === 'open') next = { k: k2, trip: other, ways: sets[k2].ways };
    }
    // The reply quotes the way chosen, in the words of its option line (Hub row 319).
    const trip = await store.trip(set.trip);
    const people = await store.people();
    const nameOf = (id) => firstName(people.find((x) => x.id === id));
    const line = trip ? `${sets.length > 1 ? `${trip.title}: ` : ''}${optionText(trip, way, way.times, opt, nameOf, cfg.timeZone ?? 'Asia/Singapore')}.` : null;
    return apply([choiceFor(set.trip, way, way.times, opt, m)], m, ctx, store, cfg, next, line);
  }
  let choices;
  const tr = action.match(/^tr:([0-9a-f-]{36}):([0-9a-f]{8}|taxi|pub)$/);
  const cl = action.match(/^cl:([0-9a-f-]{36}):([1-9])$/);
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
    const n = Number(cl[2]);
    const opt = payload?.options?.[n - 1];
    if (!opt) return [{ text: NOT_DONE.unknown }];
    // The option's line, rebuilt from what the message stored, as it was offered (Hub row 319).
    const trips = (await Promise.all((payload.trips ?? []).map((id) => store.trip(id)))).filter(Boolean);
    let line = null;
    if (payload.kind === 'clash' && trips.length === 2) line = clashLines(trips, payload.driver ?? null, payload.chain ?? null)[n - 1] ?? null;
    else if (payload.ways && trips.length === 1) {
      const adults = (await store.people()).map((x) => ({ person_id: x.id, display_name: x.display_name }));
      line = planLines(trips[0], payload, adults, cfg.timeZone ?? 'Asia/Singapore')[n - 1] ?? null;
    }
    return apply(opt.map((c) => ({ ...c, message: cl[1] })), cl[1], ctx, store, cfg, null, line);
  } else {
    return [{ text: NOT_DONE.unknown }];
  }
  return apply(choices, null, ctx, store, cfg);
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
