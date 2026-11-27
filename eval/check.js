// Scores the calendar reader against the golden set (prj02-R1 US-2). The same check runs on a
// planted set of wrong answers first (self-test): if those pass, the check itself is broken.
import { words } from '../lib/bot/calendar.js';

export function checkCase(expect, got) {
  const misses = [];
  const intents = [].concat(expect.intent);
  if (!intents.includes(got?.intent)) misses.push(`intent ${got?.intent} (want ${intents.join('/')})`);
  for (const k of ['date', 'start', 'end', 'allDay', 'newDate', 'newStart', 'targetDate', 'dateFrom', 'dateTo']) {
    if (k in expect && got?.[k] !== expect[k]) misses.push(`${k} ${got?.[k]} (want ${expect[k]})`);
  }
  for (const [k, field] of [['title_has', 'title'], ['target_has', 'targetWords']]) {
    const have = new Set(words(got?.[field]));
    for (const w of expect[k] ?? []) if (!have.has(w) && ![...have].some((h) => h.startsWith(w))) misses.push(`${field} lacks "${w}"`);
  }
  return misses;
}

export function score(golden, answers) {
  const results = golden.cases.map((c) => ({ id: c.id, misses: checkCase(c.expect, answers[c.id]) }));
  const passed = results.filter((r) => r.misses.length === 0).length;
  return { passed, total: results.length, rate: passed / results.length, ok: passed / results.length >= golden.pass_rate, results };
}

/** Planted wrong answers: every one must be caught. */
export function selfTest(golden) {
  const wrong = {};
  for (const c of golden.cases) {
    const e = c.expect; const first = [].concat(e.intent)[0];
    wrong[c.id] = first === 'add' ? { ...e, intent: 'add', date: '2026-11-30', title: 'something else' }
      : first === 'move' ? { intent: 'cancel', targetWords: 'x' }
      : first === 'cancel' ? { intent: 'move', targetWords: 'x' }
      : first === 'show' ? { intent: 'show', dateFrom: '2026-12-31', dateTo: '2026-12-31' }
      : { intent: 'add', date: '2026-11-28', start: '15:00', title: 'planted' };
  }
  const s = score(golden, wrong);
  return { caught: s.results.filter((r) => r.misses.length > 0).length, total: s.total };
}
