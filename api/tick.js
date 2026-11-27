// The scheduler's tick (ADR-02): Supabase Cron calls this once a minute. It takes no input, works
// for each family with a calendar in its own job transaction (role app_prj02_job), and sends the
// claimed messages after the transaction commits. Calling it more often changes nothing: each
// message is claimed once, scans run every scan_minutes. Logs counts and error kinds only.
import { inJobTransaction } from '../lib/db.js';
import { tickFamily } from '../lib/trips/tick.js';
import { telegramClient } from '../lib/channel/telegram.js';
import { googleCalendar } from '../lib/calendar/google.js';
import { oneMap } from '../lib/route/onemap.js';

export async function GET() {
  if (process.env.VERCEL_ENV !== 'production') return new Response('Not found', { status: 404 });
  const now = new Date();
  const telegram = telegramClient(process.env.TELEGRAM_BOT_TOKEN);
  let google = null; const lazyGoogle = () => (google ??= googleCalendar());
  const deps = {
    google: { list: (...a) => lazyGoogle().list(...a) },
    onemap: process.env.ONEMAP_EMAIL ? oneMap() : null,
  };
  const summary = { families: 0, sent: 0, failed: 0, errors: [] };
  let families;
  try {
    families = await inJobTransaction((job) => job.families());
  } catch (e) {
    console.error('prj02 tick: families failed:', e.code ?? e.name);
    return Response.json({ ok: false }, { status: 500 });
  }
  for (const family of families) {
    let outbox;
    try {
      outbox = await inJobTransaction(async (job) => {
        if (!(await job.begin(family))) return [];
        const fam = await job.load();
        if (!fam) return [];
        const r = await tickFamily(fam, { ...deps, job }, now);
        if (r.scanned?.note?.length) summary.errors.push(...r.scanned.note);
        return r.outbox;
      });
      summary.families++;
    } catch (e) {
      summary.errors.push(e.type ?? e.code ?? e.name);
      continue;
    }
    for (const m of outbox) {
      try { await telegram.send(m.chat, m.reply); summary.sent++; } catch (e) {
        summary.failed++;
        summary.errors.push(e.type ?? 'telegram');
        await inJobTransaction(async (job) => { if (await job.begin(family)) await job.markFailed(m.id); }).catch(() => {});
      }
    }
  }
  if (summary.errors.length) console.error('prj02 tick:', JSON.stringify(summary.errors.slice(0, 10)));
  return Response.json({ ok: true, ...summary, errors: summary.errors.length });
}
