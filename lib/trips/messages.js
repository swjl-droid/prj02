// Texts and buttons of the bot-started messages (prj02-R1 US-3). Buttons carry only ids; what a
// tap does is decided by the database (assign_trips), never by the button text.
import { describeWhen, localParts } from '../calendar/dates.js';

const time = (iso, tz) => localParts(tz, new Date(iso)).time;
const drive = (t) => `drive about ${t.drive_min} min${t.drive_source === 'estimate' ? ' (est.)' : ''}`;
const what = (t, tz) => `${t.title}, ${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)}${t.location ? ` at ${t.location}` : ''}`;

/** "Who takes it?" with one button per adult, plus taxi and public transport. */
export function planMessage(t, adults, tz, dayWord) {
  const people = adults.map((a) => ({ label: a.display_name.split(' ')[0].slice(0, 20), action: `tr:${t.id}:${a.person_id.slice(0, 8)}` }));
  return {
    text: [
      `${dayWord}: ${what(t, tz)}.`,
      `${drive(t)[0].toUpperCase()}${drive(t).slice(1)}: leave ${time(t.drop_leave_at, tz)} for drop-off, ${time(t.pick_leave_at, tz)} for pick-up.`,
      'Who takes it?',
    ].join('\n'),
    buttons: [people.slice(0, 4), [{ label: 'Taxi', action: `tr:${t.id}:taxi` }, { label: 'Public transport', action: `tr:${t.id}:pub` }]],
  };
}

/** Clash of two trips with one car: 2 options computed in code. */
export function clashMessage(reminderId, [a, b], driverName, tz) {
  const d = driverName ? `${driverName} drives` : 'By car';
  return {
    text: [
      `Clash on ${describeWhen({ dateTime: a.event_start }, null, tz).split(',')[0]}: the car is needed for both`,
      `- ${a.title} ${time(a.event_start, tz)} (leave ${time(a.drop_leave_at, tz)})`,
      `- ${b.title} ${time(b.event_start, tz)} (leave ${time(b.drop_leave_at, tz)})`,
      `Option 1: ${d} ${a.title}; ${b.title} by taxi.`,
      `Option 2: ${d} ${b.title}; ${a.title} by taxi.`,
      'Which one?',
    ].join('\n'),
    buttons: [[{ label: 'Option 1', action: `cl:${reminderId}:1` }, { label: 'Option 2', action: `cl:${reminderId}:2` }]],
  };
}

/** A reminder at leave time to the trip's owner (or, for taxi / public transport, the adult who chose it). */
export function reminderMessage(kind, t, tz, { early = false, tomorrow = false } = {}) {
  const leave = time(kind === 'drop' ? t.drop_leave_at : t.pick_leave_at, tz);
  const head = !early ? 'Time to leave'
    : tomorrow ? `For tomorrow morning (sent now, before quiet hours): leave at ${leave}` : `Coming up: leave at ${leave}`;
  if (t.owner_mode === 'taxi') {
    return { text: `${early ? head.replace('leave at', 'book the taxi for') : 'Book the taxi now'}: ${kind === 'drop' ? 'drop-off for' : 'pick-up from'} ${what(t, tz)}.` };
  }
  if (t.owner_mode === 'public') {
    return { text: `${head}: ${kind === 'drop' ? '' : 'coming back from '}${what(t, tz)} by public transport.` };
  }
  return { text: `${head}: ${kind === 'drop' ? 'drop-off for' : 'pick-up from'} ${what(t, tz)}. ${drive(t)[0].toUpperCase()}${drive(t).slice(1)}.` };
}

/** Reply after a tap: who takes it and when the reminders come. */
export function assignedReply(trips, people, tz) {
  const name = (id) => people.find((p) => p.id === id)?.display_name ?? 'an adult';
  return trips.map((t) => {
    const who = t.owner_mode === 'taxi' ? 'Taxi' : t.owner_mode === 'public' ? 'Public transport' : `${name(t.owner_person_id)} takes it`;
    return `Done: ${t.title} (${describeWhen({ dateTime: t.event_start }, { dateTime: t.event_end }, tz)}): ${who}. Reminders: leave ${time(t.drop_leave_at, tz)} for drop-off, ${time(t.pick_leave_at, tz)} for pick-up.`;
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
