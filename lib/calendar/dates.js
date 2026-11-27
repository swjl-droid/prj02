// Dates in the family's time zone (Singapore in release 1), without a date library.

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'GMT+08:00' -> '+08:00' for the zone at that instant. */
export function offsetFor(timeZone, at = new Date()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = part.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+00:00';
}

/** { date: 'YYYY-MM-DD', time: 'HH:MM', weekday: 'Fri' } of an instant in the zone. */
export function localParts(timeZone, at = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(date) { return WD[new Date(`${date}T00:00:00Z`).getUTCDay()]; }

/** The next n days as 'Fri 27 Nov 2026 = 2026-11-27' lines, for the model to look dates up. */
export function dayTable(today, n = 15) {
  // Weeks run Monday to Sunday; each line says which week it is in, so "next week Tue" is a lookup.
  const dow = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const monday = addDays(today, -dow(today));
  const weekName = ['this week', 'next week', 'the week after next'];
  return Array.from({ length: n }, (_, i) => {
    const d = addDays(today, i);
    const [y, m, day] = d.split('-');
    const w = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * 86400e3));
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    return `${weekday(d)} ${Number(day)} ${MO[Number(m) - 1]} ${y} = ${d}${tag} [${weekName[w] ?? 'later'}]`;
  }).join('\n');
}

/** '2026-11-28' + '15:00' in the zone -> '2026-11-28T15:00:00+08:00'. */
export function isoAt(date, time, timeZone) {
  const off = offsetFor(timeZone, new Date(`${date}T12:00:00Z`));
  return `${date}T${time}:00${off}`;
}

export function addMinutes(date, time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const days = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return { date: addDays(date, days), time: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}` };
}

/** 'Sat 28 Nov, 15:00-16:00' from a Google event's start and end, shown in the zone. */
export function describeWhen(start, end, timeZone) {
  if (start?.date) {
    const d = start.date;
    return `${weekday(d)} ${Number(d.slice(8))} ${MO[Number(d.slice(5, 7)) - 1]}, all day`;
  }
  const s = localParts(timeZone, new Date(start.dateTime));
  const e = end?.dateTime ? localParts(timeZone, new Date(end.dateTime)) : null;
  const day = `${s.weekday} ${Number(s.date.slice(8))} ${MO[Number(s.date.slice(5, 7)) - 1]}`;
  if (!e) return `${day}, ${s.time}`;
  return e.date === s.date ? `${day}, ${s.time}-${e.time}` : `${day}, ${s.time} to ${describeWhen({ dateTime: end.dateTime }, null, timeZone)}`;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
