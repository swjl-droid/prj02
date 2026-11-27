// Calendar changes by chat (prj02-R1 US-2). An adult asks to add, move or cancel a family event;
// the bot shows exactly what it will change and writes to the shared calendar only after that
// same adult taps Yes (L1, Hub row 128). Unclear requests get one clarifying question. Every
// proposal, yes / no and result is logged in app_prj02.calendar_changes (and core.agent_runs).
//
// deps: { interpret(text) -> checked request, google: { list, insert, patch, remove }, now() }
// store: the per-message database store (lib/db.js); cfg: settings (lib/config.js)

import { isoAt, addMinutes, addDays, describeWhen, localParts } from '../calendar/dates.js';
import { whatsOn } from './trips.js';

const STOP = new Set(['the', 'a', 'an', 'my', 'our', 's', 'to', 'for', 'at', 'on', 'in', 'of', 'and', 'with', 'event', 'appointment']);
export const words = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/'s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

/** Events whose title shares most of the target words; ties are all returned. */
export function bestMatches(events, targetWords) {
  const want = [...new Set(words(targetWords))];
  if (want.length === 0) return [];
  const scored = events.map((e) => {
    const have = new Set(words(e.summary));
    const hit = want.filter((w) => have.has(w) || [...have].some((h) => h.length > 3 && (h.startsWith(w) || w.startsWith(h)))).length;
    return { e, score: hit / want.length };
  }).filter((x) => x.score >= 0.5);
  const top = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === top).map((x) => x.e);
}

const when = (ev, tz) => describeWhen(ev.start, ev.end, tz);

function proposalText(action, p, tz) {
  const lines = {
    add: () => ['Add to the Family calendar:', `- ${p.title}`, `- ${when(p, tz)}`, ...(p.location ? [`- at ${p.location}`] : []), 'Write it to the calendar?'],
    move: () => ['Move in the Family calendar:', `- ${p.title}`, `- from ${when(p.before, tz)}`, `- to ${when(p, tz)}`, 'Write the change?'],
    cancel: () => ['Cancel (delete) from the Family calendar:', `- ${p.title}`, `- ${when(p.before, tz)}`, 'Delete it?'],
  }[action]();
  return lines.join('\n');
}

const buttons = (id, yes) => [[{ label: yes, action: `cal-yes:${id}` }, { label: 'No', action: `cal-no:${id}` }]];

/** A calendar request in plain text from a member who has agreed to the notice. */
export async function handleCalendarText(msg, ctx, store, deps, cfg) {
  const cal = await store.calendar();
  if (!cal) return [{ text: "Your family's calendar is not connected yet. Ask your family admin." }];
  const tz = cal.time_zone;
  const req = await deps.interpret(msg.text, { tenantId: ctx.family_id, timeZone: tz });

  if (req.intent === 'not_calendar') return null; // the caller shows the help text
  if (req.intent === 'unclear') return [{ text: req.question }];
  if (req.intent === 'show') return whatsOn(req, store, deps, tz, deps.now());

  if (req.intent === 'add') {
    const start = req.allDay ? { date: req.date } : { dateTime: isoAt(req.date, req.start, tz), timeZone: tz };
    let end;
    if (req.allDay) end = { date: addDays(req.date, 1) };
    else {
      const e = req.end ? { date: req.date, time: req.end } : addMinutes(req.date, req.start, cfg.defaultEventMinutes);
      end = { dateTime: isoAt(e.date, e.time, tz), timeZone: tz };
    }
    const p = { title: req.title, start, end, ...(req.location ? { location: req.location } : {}) };
    const id = await store.proposeChange('add', null, p, cfg.changeValidMinutes);
    return [{ text: proposalText('add', p, tz), buttons: buttons(id, 'Yes, add it') }];
  }

  // move or cancel: find the one event meant.
  const nowLocal = localParts(tz, deps.now());
  const from = req.targetDate ? isoAt(req.targetDate, '00:00', tz) : new Date(deps.now()).toISOString();
  const to = req.targetDate ? isoAt(addDays(req.targetDate, 1), '00:00', tz) : isoAt(addDays(nowLocal.date, cfg.searchDays), '00:00', tz);
  const events = await deps.google.list(cal.external_id, from, to);
  const found = bestMatches(events, req.targetWords);
  const span = req.targetDate ? `on ${describeWhen({ date: req.targetDate }, null, tz).replace(', all day', '')}` : `in the next ${cfg.searchDays} days`;
  if (found.length === 0) {
    return [{ text: `I could not find "${req.targetWords}" in the Family calendar ${span}. What is the event called, and on which day is it?` }];
  }
  if (found.length > 1) {
    const list = found.slice(0, 5).map((e) => `- ${e.summary} (${when(e, tz)})`).join('\n');
    return [{ text: `I found more than one:\n${list}\nWhich one do you mean? Please include its day.` }];
  }
  const ev = found[0];
  const before = { title: ev.summary, start: ev.start, end: ev.end };

  if (req.intent === 'cancel') {
    const p = { title: ev.summary, before };
    const id = await store.proposeChange('cancel', ev.id, p, cfg.changeValidMinutes);
    return [{ text: proposalText('cancel', p, tz), buttons: buttons(id, 'Yes, delete it') }];
  }

  // move: keep the length of the event unless a new end is given.
  if (ev.start.date) return [{ text: `"${ev.summary}" is an all-day event; moving those by chat comes later. Please change it in the calendar.` }];
  const s = localParts(tz, new Date(ev.start.dateTime));
  const lengthMin = Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000);
  const day = req.newDate ?? s.date;
  const startTime = req.newStart ?? s.time;
  const endAt = req.newEnd ? { date: day, time: req.newEnd } : addMinutes(day, startTime, lengthMin);
  const p = {
    title: ev.summary,
    start: { dateTime: isoAt(day, startTime, tz), timeZone: tz },
    end: { dateTime: isoAt(endAt.date, endAt.time, tz), timeZone: tz },
    before,
  };
  if (day === s.date && startTime === s.time && !req.newEnd) {
    return [{ text: `"${ev.summary}" is already at ${when(ev, tz)}. To when should I move it?` }];
  }
  const id = await store.proposeChange('move', ev.id, p, cfg.changeValidMinutes);
  return [{ text: proposalText('move', p, tz), buttons: buttons(id, 'Yes, move it') }];
}

const NOT_DONE = {
  not_yours: 'Only the adult who asked for this change can confirm it.',
  expired: 'This proposal has expired. Please ask again.',
  applied: 'This change is already done.',
  declined: 'This change was already declined.',
  failed: 'This change failed earlier. Please ask again.',
  approved: 'This change is already being written.',
  unknown: 'I cannot find this change any more. Please ask again.',
};

/** Yes / No on a proposal ('cal-yes:<id>' or 'cal-no:<id>'). */
export async function handleCalendarButton(action, ctx, store, deps) {
  const m = action.match(/^cal-(yes|no):([0-9a-f-]{36})$/);
  if (!m) return [{ text: NOT_DONE.unknown }];
  const [, answer, id] = m;
  const d = await store.decideChange(id, answer === 'yes');
  if (!d.ok) return [{ text: NOT_DONE[d.reason] ?? NOT_DONE.unknown }];
  if (d.status === 'declined') return [{ text: 'OK, nothing was changed.' }];

  const cal = await store.calendar();
  const p = d.proposal;
  try {
    let eventId = d.event_id;
    if (d.action === 'add') {
      const created = await deps.google.insert(cal.external_id, {
        summary: p.title, start: p.start, end: p.end, ...(p.location ? { location: p.location } : {}),
        description: 'Added by the family bot after an adult said yes.',
        extendedProperties: { private: { prj02_change: id } },
      });
      eventId = created?.id ?? null;
    } else if (d.action === 'move') {
      await deps.google.patch(cal.external_id, eventId, { start: p.start, end: p.end });
    } else {
      await deps.google.remove(cal.external_id, eventId);
    }
    await store.recordResult(id, true, eventId, null);
    const done = { add: 'Added', move: 'Moved', cancel: 'Deleted' }[d.action];
    return [{ text: `Done: ${done} "${p.title}"${d.action === 'cancel' ? '' : ` (${describeWhen(p.start, p.end, cal.time_zone)})`}.` }];
  } catch (e) {
    const kind = e.type ?? 'unknown';
    await store.recordResult(id, false, null, String(kind).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40));
    const why = kind === 'not_shared' ? 'the bot has no access to the Family calendar (is it still shared with the bot?)'
      : kind === 'not_found' || kind === 'gone' ? 'the event is no longer in the calendar' : 'the calendar did not answer';
    return [{ text: `Sorry, I could not write the change: ${why}. Nothing was changed.` }];
  }
}
