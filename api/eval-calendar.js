// Live check of the calendar request reader (prj02-R1 US-2): the golden set's noisy messages go
// through the real model via the gateway (about US$0.01 for 20 calls). Previews only: production
// answers 404; previews are behind Vercel Authentication. The checker's self-test runs first.
import { readFileSync } from 'node:fs';
import { createGateway } from '../lib/gateway/index.js';
import { interpret } from '../lib/bot/interpret.js';
import { score, selfTest } from '../eval/check.js';
import { settings } from '../lib/config.js';

const golden = JSON.parse(readFileSync(new URL('../eval/calendar-golden.json', import.meta.url), 'utf8'));

export async function GET() {
  if (process.env.VERCEL_ENV !== 'preview') return new Response('Not found', { status: 404 });
  const self = selfTest(golden);
  if (self.caught !== self.total) return Response.json({ ok: false, selfTest: self, note: 'checker broken' }, { status: 500 });
  const gateway = createGateway({ app: 'prj02' });
  const answers = {};
  await Promise.all(golden.cases.map(async (c) => {
    try {
      answers[c.id] = await interpret(c.text, { gateway, model: settings.calendar_model, today: golden.today,
        now: golden.now, weekday: golden.weekday, timeZone: golden.time_zone, tenantId: null });
    } catch (e) { answers[c.id] = { intent: `error:${e.type ?? e.name}` }; }
  }));
  const s = score(golden, answers);
  return Response.json({ ok: s.ok, passed: s.passed, total: s.total, rate: s.rate, need: golden.pass_rate, selfTest: self,
    model: settings.calendar_model,
    failures: s.results.filter((r) => r.misses.length).map((r) => ({ id: r.id, misses: r.misses, got: answers[r.id] })) });
}
