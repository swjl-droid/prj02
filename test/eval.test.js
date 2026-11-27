// The golden-set checker itself (prj02-R1 US-2): catches every planted wrong answer, passes right ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score, selfTest } from '../eval/check.js';
import { checkForm } from '../lib/bot/interpret.js';

const golden = JSON.parse(readFileSync(new URL('../eval/calendar-golden.json', import.meta.url), 'utf8'));

test('the checker catches all planted wrong answers', () => {
  const s = selfTest(golden);
  assert.equal(s.caught, s.total);
  assert.equal(golden.cases.length, 20);
});

test('a perfect set of model forms passes the checker after checkForm', () => {
  const forms = {
    c01: { intent: 'add', title: 'Ethan swim', date: '2026-11-28', start: '15:00', location: 'Jurong West pool' },
    c02: { intent: 'add', title: 'Mei dentist', date: '2026-11-28', start: '10:30' },
    c03: { intent: 'add', title: 'Ethan piano lesson', date: '2026-12-03', start: '16:00', end: '16:45' },
    c04: { intent: 'add', title: 'Grandma birthday', date: '2026-12-05', all_day: true },
    c05: { intent: 'unclear', question: 'What time is swim class on Saturday?' },
    c06: { intent: 'move', target_words: 'Ethan piano', new_date: '2026-12-03', new_start: '17:00' },
    c07: { intent: 'move', target_words: 'tuition', target_date: '2026-12-02', new_date: '2026-12-04' },
    c08: { intent: 'cancel', target_words: 'karate', target_date: '2026-11-28' },
    c09: { intent: 'cancel', target_words: 'Mei ballet', target_date: '2026-12-01' },
    c10: { intent: 'not_calendar' }, c11: { intent: 'not_calendar' },
    c12: { intent: 'unclear', question: 'One change at a time please.' }, c13: { intent: 'unclear', question: 'Which event?' },
    c14: { intent: 'add', title: 'PTM at school', date: '2026-12-01', start: '19:00' },
    c15: { intent: 'add', title: 'Ethan football', date: '2026-11-29', start: '09:00', end: '11:00', location: 'Bishan' },
    c16: { intent: 'not_calendar' }, c17: { intent: 'unclear', question: 'Which date?' },
    c18: { intent: 'add', title: 'Lunch with in-laws', date: '2026-11-29', start: '12:00' },
    c19: { intent: 'unclear', question: 'Which event?' }, c20: { intent: 'unclear', question: 'To what time?' },
  };
  const answers = Object.fromEntries(Object.entries(forms).map(([k, f]) => [k, checkForm(f, golden.today)]));
  const s = score(golden, answers);
  assert.deepEqual(s.results.filter((r) => r.misses.length), []);
  assert.equal(s.ok, true);
});
