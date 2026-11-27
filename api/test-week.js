// The US-3 test week (decision 27/11/2026: 10 [TEST] events allowed in the Family calendar, deleted
// afterwards). Previews only (behind Vercel Authentication); production answers 404.
//   /api/test-week?do=create  puts the 10 events from today to Sunday (skips any already there)
//   /api/test-week?do=delete  deletes every event this page created (title [TEST] + its marker)
//   /api/test-week            lists them
// Uses the scheduler's role to find the family's calendar, and the bot's Google account to write.
import { inJobTransaction } from '../lib/db.js';
import { googleCalendar } from '../lib/calendar/google.js';
import { localParts, addDays, isoAt } from '../lib/calendar/dates.js';

const MARK = 'prj02-R1 US-3 test week';

export function weekPlan(today) {
  // today = 'YYYY-MM-DD' (a Friday on 27/11); days after it: +1 Saturday, +2 Sunday.
  const d0 = today; const d1 = addDays(today, 1); const d2 = addDays(today, 2);
  return [
    [d0, '16:00', '17:00', 'Mei tuition', 'Bishan Library'],
    [d0, '18:30', '19:30', 'Ethan swim', 'Jurong West Swimming Complex'],
    [d1, '06:30', '08:00', 'Ethan swim training', 'Jurong West Swimming Complex'],
    [d1, '09:00', '10:00', 'Mei ballet', 'Bishan'],
    [d1, '09:15', '10:15', 'Ethan football', 'Toa Payoh Stadium'],
    [d1, '14:00', '15:00', 'Ethan piano', null],
    [d1, '18:00', '19:30', "Dinner at Grandma's", 'Kuala Lumpur'],
    [d2, '10:00', '11:00', 'Mei swim', 'Jurong West Swimming Complex'],
    [d2, '13:00', '14:00', 'Ethan tuition', 'Bishan Library'],
    [d2, '21:45', '22:40', 'Movie night', 'Bishan'],
  ];
}

export async function GET(request) {
  if (process.env.VERCEL_ENV !== 'preview') return new Response('Not found', { status: 404 });
  const action = new URL(request.url).searchParams.get('do') ?? 'show';
  const families = await inJobTransaction((job) => job.families());
  if (families.length !== 1) return Response.json({ ok: false, note: `expected 1 family, found ${families.length}` }, { status: 409 });
  const fam = await inJobTransaction(async (job) => ((await job.begin(families[0])) ? job.load() : null));
  if (!fam) return Response.json({ ok: false, note: 'no family settings or calendar' }, { status: 409 });
  const tz = fam.time_zone; const g = googleCalendar();
  const today = localParts(tz).date;
  const from = isoAt(today, '00:00', tz); const to = isoAt(addDays(today, 4), '00:00', tz);
  const mine = (await g.list(fam.calendar_id, from, to)).filter((e) => /^\[TEST\]/.test(e.summary ?? '') && (e.description ?? '').includes(MARK));
  if (action === 'delete') {
    for (const e of mine) await g.remove(fam.calendar_id, e.id);
    return Response.json({ ok: true, deleted: mine.length });
  }
  if (action === 'create') {
    let created = 0;
    for (const [day, s, e, title, location] of weekPlan(today)) {
      const summary = `[TEST] ${title}`;
      if (mine.some((x) => x.summary === summary)) continue;
      await g.insert(fam.calendar_id, { summary, ...(location ? { location } : {}), description: `${MARK} (delete with /api/test-week?do=delete)`,
        start: { dateTime: isoAt(day, s, tz), timeZone: tz }, end: { dateTime: isoAt(day, e, tz), timeZone: tz } });
      created++;
    }
    return Response.json({ ok: true, created });
  }
  return Response.json({ ok: true, events: mine.map((e) => ({ title: e.summary, start: e.start?.dateTime, location: e.location ?? null })) });
}
