// Texts and buttons of the bot-started messages (prj02-R1 US-3). Buttons carry only ids; what a
// tap does is decided by the database (assign_trips), never by the button text.
import { describeWhen, localParts } from '../calendar/dates.js';
import { placeLabel } from './plan.js';
import { optionText, firstName, allOptions } from './ways.js';

const time = (iso, tz) => localParts(tz, new Date(iso)).time;
const drive = (t) => `drive about ${t.drive_min} min${t.drive_source === 'estimate' ? ' (est.)' : ''}`;
const what = (t, tz) => `${t.title}, ${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)}${t.location ? ` at ${placeLabel(t.location)}` : ''}`;
const dropOn = (t) => t.drop_needed !== false && t.drop_mode !== 'none';
const pickOn = (t) => t.pick_needed !== false && t.pick_mode !== 'none';
/** "leave 14:32 for drop-off, 16:07 for pick-up", saying which legs are not needed (stay rule, own plan). */
function legsText(t, tz) {
  const parts = [];
  parts.push(dropOn(t) ? `leave ${time(t.drop_leave_at, tz)} for drop-off` : 'no drop-off (already there)');
  parts.push(!pickOn(t) ? 'no pick-up (stays on)'
    : t.wait_there ? `waiting there, pick-up at ${time(t.pick_at ?? t.event_end, tz)} (reminder ${time(t.pick_leave_at, tz)})`
      : `${dropOn(t) ? '' : 'leave '}${time(t.pick_leave_at, tz)} for pick-up${t.pick_at ? ` at ${time(t.pick_at, tz)}` : ''}`);
  return parts.join(', ');
}

/** The buttons under a clash or 'who takes it?' message (US-9): its options, other ways, own plan. */
export function mainButtons(messageId, nOptions) {
  return [
    Array.from({ length: nOptions }, (_, i) => ({ label: `Option ${i + 1}`, action: `cl:${messageId}:${i + 1}` })),
    [{ label: 'Other ways…', action: `ow:${messageId}` }],
    [{ label: 'My own plan…', action: `op:${messageId}` }],
  ].filter((row) => row.length);
}

/**
 * "Who takes it?" (US-9): at most 3 options built from the ways of doing a trip and the family's
 * adults, the usual choice of this activity first, then "Other ways…" and "My own plan…".
 */
export function planMessage(messageId, t, payload, adults, tz, dayWord) {
  const nameOf = (id) => firstName(adults.find((a) => a.person_id === id));
  const lines = (payload.top ?? []).map((o, i) => {
    const w = payload.ways.find((x) => x.id === o.way);
    return `Option ${i + 1}: ${optionText(t, w, w.times, o, nameOf, tz)}.`;
  });
  return {
    text: [
      `${dayWord}: ${what(t, tz)}.`,
      `${drive(t)[0].toUpperCase()}${drive(t).slice(1)}: ${legsText(t, tz)}.`,
      ...lines,
      lines.length ? "Or tap 'Other ways…', or 'My own plan…' and tell me in a few words." : "Tap 'Other ways…', or 'My own plan…' and tell me in a few words.",
    ].join('\n'),
    buttons: mainButtons(messageId, lines.length),
  };
}

/** "Other ways…", step 1 under a clash: which activity. */
export function tripButtons(messageId, trips) {
  return [...trips.map((t, k) => [{ label: t.title.slice(0, 40), action: `ow:${messageId}:${k}` }]), [{ label: '« Back', action: `ob:${messageId}` }]];
}

/** "Other ways…", step 2: how (one button per way of the list that can be timed for this trip). */
export function wayButtons(messageId, k, ways) {
  return [...ways.map((w, i) => [{ label: w.label.slice(0, 40), action: `ow:${messageId}:${k}:${i}` }]), [{ label: '« Back', action: `ob:${messageId}` }]];
}

/** "Other ways…", step 3: who, for the legs an adult does ("John there, Mei back"). */
export function whoButtons(messageId, k, i, way, people) {
  const adults = people.map((p) => ({ person_id: p.id, display_name: p.display_name }));
  const opts = allOptions([way], adults, () => true);
  const name = (id) => firstName(adults.find((a) => a.person_id === id));
  const hex = (id) => (id ? id.slice(0, 8) : '-');
  const label = (o) => (o.drop_by && o.pick_by && o.drop_by !== o.pick_by ? `${name(o.drop_by)} there, ${name(o.pick_by)} back`
    : name(o.drop_by ?? o.pick_by));
  return { opts, buttons: [...opts.slice(0, 8).map((o) => [{ label: label(o), action: `ow:${messageId}:${k}:${i}:${hex(o.drop_by)}:${hex(o.pick_by)}` }]),
    [{ label: '« Back', action: `ob:${messageId}` }]] };
}

/** "Who takes it?" of release 1 (messages queued before US-9): one button per adult, taxi, public transport. */
export function legacyPlanMessage(t, adults, tz, dayWord) {
  const people = adults.map((a) => ({ label: a.display_name.split(' ')[0].slice(0, 20), action: `tr:${t.id}:${a.person_id.slice(0, 8)}` }));
  return {
    text: [
      `${dayWord}: ${what(t, tz)}.`,
      `${drive(t)[0].toUpperCase()}${drive(t).slice(1)}: ${legsText(t, tz)}.`,
      'Who takes it?',
    ].join('\n'),
    buttons: [people.slice(0, 4), [{ label: 'Taxi', action: `tr:${t.id}:taxi` }, { label: 'Public transport', action: `tr:${t.id}:pub` }]],
  };
}

/** Clash of two trips with one car: 2 options computed in code. */
export function clashMessage(reminderId, [a, b], driverName, tz, chain = null) {
  const d = driverName ? `${driverName} drives` : 'By car';
  return {
    text: [
      `Clash on ${describeWhen({ dateTime: a.event_start }, null, tz).split(',')[0]}: the car is needed for both`,
      `- ${a.title} ${time(a.event_start, tz)}-${time(a.event_end, tz)} (${legsText(a, tz)})`,
      `- ${b.title} ${time(b.event_start, tz)}-${time(b.event_end, tz)} (${legsText(b, tz)})`,
      `Option 1: ${d} ${a.title}; ${b.title} by taxi.`,
      `Option 2: ${d} ${b.title}; ${a.title} by taxi.`,
      ...(chain ? [`Option 3: ${driverName ?? 'One adult'} does both: ${chain}.`] : []),
      "Or tap 'Other ways…' to decide each activity on its own, or 'My own plan…' and tell me in a few words.",
    ].join('\n'),
    buttons: mainButtons(reminderId, chain ? 3 : 2),
  };
}

/** A reminder at leave time to the trip's owner (or, for taxi / public transport, the adult who chose it). */
export function reminderMessage(kind, t, tz, { early = false, tomorrow = false } = {}) {
  const leave = time(kind === 'drop' ? t.drop_leave_at : t.pick_leave_at, tz);
  const note = t[`${kind}_note`]; // a chained trip (US-8): "then Acro @ Dunearn - Ang", "you wait there"
  const waiting = note === 'you wait there' || (kind === 'pick' && t.wait_there === true); // US-9: drop off and wait
  const head = waiting ? `Pick-up at ${time(t.pick_at ?? t.event_end, tz)} (you are there)`
    : !early ? 'Time to leave'
      : tomorrow ? `For tomorrow morning (sent now, before quiet hours): leave at ${leave}` : `Coming up: leave at ${leave}`;
  const tail = note && !waiting ? ` (${note})` : '';
  // A leg's own way (US-8): its taxi / public transport, or an adult named for it (who drives), else the trip's.
  const mode = ['taxi', 'public'].includes(t[`${kind}_mode`]) ? t[`${kind}_mode`] : t[`${kind}_person`] ? 'adult' : t.owner_mode;
  if (mode === 'taxi') {
    return { text: `${early ? head.replace('leave at', 'book the taxi for') : 'Book the taxi now'}: ${kind === 'drop' ? 'drop-off for' : 'pick-up from'} ${what(t, tz)}${tail}.` };
  }
  if (mode === 'public') {
    return { text: `${head}: ${kind === 'drop' ? '' : 'coming back from '}${what(t, tz)} by public transport${tail}.` };
  }
  if (waiting) return { text: `${head}: ${what(t, tz)}.` };
  if (t[`${kind}_mode`] === 'walk') {
    return { text: `${head}: walk ${kind === 'drop' ? 'to the drop-off for' : 'to pick up from'} ${what(t, tz)}${tail}.` };
  }
  return { text: `${head}: ${kind === 'drop' ? 'drop-off for' : 'pick-up from'} ${what(t, tz)}${tail}. ${drive(t)[0].toUpperCase()}${drive(t).slice(1)}.` };
}

/** The tapped message after a choice (US-9): what was chosen, by whom and when; no options left. */
export function chosenMessage(messageId, trips, people, tz, byId, at) {
  const by = people.find((p) => p.id === byId)?.display_name?.split(' ')[0] ?? 'an adult';
  return {
    edit: true,
    text: [`Chosen by ${by} at ${localParts(tz, at).time}:`, assignedReply(trips, people, tz),
      "To change it, tap 'My own plan…'."].join('\n'),
    buttons: [[{ label: 'My own plan…', action: `op:${messageId}` }]],
  };
}

/** Reply after a tap: who takes it and when the reminders come. */
export function assignedReply(trips, people, tz) {
  const name = (id) => people.find((p) => p.id === id)?.display_name ?? 'an adult';
  return trips.map((t) => {
    const who = t.owner_mode === 'taxi' ? 'Taxi' : t.owner_mode === 'public' ? 'Public transport' : `${name(t.owner_person_id)} takes it`;
    // US-8 / US-9: a leg by another adult or way, and a wait there.
    const legWay = (leg) => (t[`${leg}_person`] ? `${name(t[`${leg}_person`])}` : { taxi: 'taxi', public: 'public transport', walk: 'on foot' }[t[`${leg}_mode`]] ?? null);
    const extra = [legWay('drop') && `drop-off: ${legWay('drop')}`, t.wait_there ? 'waits there' : legWay('pick') && `pick-up: ${legWay('pick')}`].filter(Boolean);
    return `Done: ${t.title} (${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)}): ${who}${extra.length ? ` (${extra.join(', ')})` : ''}. Reminders: ${legsText(t, tz)}.`;
  }).join('\n');
}

/**
 * Warning about an event whose notes or place read like an instruction to the bot (US-4, AI-L08
 * case 2). The notes are not repeated; the event stays out of the plan until "Include it".
 */
export function warningMessage(t, tz) {
  return {
    text: [
      `Warning: the notes of "${t.title.slice(0, 60)}" (${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)}) contain what looks like an instruction to the bot, such as inviting or sharing.`,
      'I never follow instructions written in calendar events, and I have left this event out of the plan.',
      "If it is a normal activity, tap 'Include it'.",
    ].join('\n'),
    buttons: [[{ label: 'Include it', action: `hd:${t.id}` }]],
  };
}

/** "Who is X?" for a name the family has not listed (US-7): one button per child, or not a child. */
export function unknownMessage(t, children, tz) {
  const buttons = children.slice(0, 6).map((c) => ({ label: `It's ${c.name.split(' ')[0].slice(0, 20)}`, action: `ca:${t.id}:${c.id.slice(0, 8)}` }));
  return {
    text: [
      `Who is "${String(t.unknown_name ?? '').slice(0, 30)}" in "${t.title.slice(0, 60)}" (${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)})?`,
      'I leave this event out of the plan until you tell me. Tap the child it is (the name is kept as a nickname),',
      "or 'Not a child' if it is an adult's own event. To add a new child: /children add Name = nickname, short name",
    ].join('\n'),
    buttons: [...(buttons.length ? [buttons] : []), [{ label: 'Not a child', action: `cn:${t.id}` }]],
  };
}

/** One child in two places at once (US-7): most likely a mistake in the calendar. */
export function doubleMessage(t, other, tz) {
  const when = (x) => describeWhen({ dateTime: x.event_start }, { dateTime: x.event_end }, tz);
  return {
    text: [
      'These two events seem to need the same child in two places at once:',
      `- ${other.title}, ${when(other)}${other.location ? ` at ${placeLabel(other.location)}` : ''}`,
      `- ${t.title}, ${when(t)}${t.location ? ` at ${placeLabel(t.location)}` : ''}`,
      'Is one of them wrong? You can fix it in the calendar or tell me in words (e.g. "cancel art on Sunday").',
    ].join('\n'),
  };
}
