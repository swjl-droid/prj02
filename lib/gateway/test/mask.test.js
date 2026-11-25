import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, maskDeep } from '../mask.js';

test('emails, Singapore phones, NRIC and FIN are masked', () => {
  const s = 'Mail tan.mei@example.com, call +65 9123 4567 or 61234567, NRIC S1234567D, FIN g7654321x.';
  assert.equal(maskText(s), 'Mail [EMAIL], call [PHONE] or [PHONE], NRIC [NRIC], FIN [NRIC].');
});

test('international numbers with + are masked, dates and amounts are kept', () => {
  assert.equal(maskText('Ring +44 20 7946 0958 on 2026-11-25 about $1,250'), 'Ring [PHONE] on 2026-11-25 about $1,250');
});

test('given names passed in are masked as whole words, any case, longest first', () => {
  const s = 'Mary Ann met mary and Maryland folks; Ann too.';
  assert.equal(maskText(s, ['Mary', 'Mary Ann', 'Ann']), '[NAME] met [NAME] and Maryland folks; [NAME] too.');
});

test('names it was not told about are NOT masked (why prj02 sends no content)', () => {
  assert.equal(maskText('Ah Boy has football at 4pm'), 'Ah Boy has football at 4pm');
});

test('maskDeep walks messages and drops binary data', () => {
  const m = [{ role: 'user', content: [
    { type: 'text', text: 'I am Mary, mary@x.io' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ] }];
  const out = maskDeep(m, ['Mary']);
  assert.equal(out[0].content[0].text, 'I am [NAME], [EMAIL]');
  assert.equal(out[0].content[1].source, '[BINARY]');
  assert.equal(m[0].content[0].text, 'I am Mary, mary@x.io', 'input not changed');
});
