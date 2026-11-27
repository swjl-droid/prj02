// OneMap lookups with locations written the way people and Google Calendar really write them
// (gap 27/11, Hub row 276): the fake OneMap below behaves like the real search, which finds a
// bare postal code or a building name but nothing for "Name, Singapore 123456".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneMap, searchTerms, _resetOneMapToken } from '../lib/route/onemap.js';

const KNOWN = {
  '098652': [1.2731, 103.8203], // home
  '569933': [1.3496, 103.8494], // a pool's postal code
  'BISHAN SPORTS HALL': [1.3550, 103.8510],
  '049483': [1.2840, 103.8510],
};

function fakeFetch() {
  const asked = [];
  const impl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/getToken')) {
      return { ok: true, json: async () => ({ access_token: 't', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3 * 86400) }) };
    }
    if (u.pathname.endsWith('/elastic/search')) {
      const q = u.searchParams.get('searchVal');
      asked.push(q);
      const p = KNOWN[q.toUpperCase()];
      return { ok: true, json: async () => ({ found: p ? 1 : 0, results: p ? [{ LATITUDE: String(p[0]), LONGITUDE: String(p[1]) }] : [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, asked };
}

test('search terms: postal code first, then the text, then the part before the first comma', () => {
  assert.deepEqual(searchTerms('569933, Singapore 569933'), ['569933', '569933, Singapore 569933']);
  assert.deepEqual(searchTerms('Singapore 569933'), ['569933', 'Singapore 569933']);
  assert.deepEqual(searchTerms('Bishan Sports Hall, 5 Bishan St 14, Singapore 579783'),
    ['579783', 'Bishan Sports Hall, 5 Bishan St 14, Singapore 579783', 'Bishan Sports Hall']);
  assert.deepEqual(searchTerms('  569933  '), ['569933']);
  assert.deepEqual(searchTerms('Toa Payoh'), ['Toa Payoh']);
  assert.deepEqual(searchTerms('Tel 61234567, Room 2'), ['Tel 61234567, Room 2', 'Tel 61234567'], '8 digits is not a postal code');
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(searchTerms(null), []);
});

const NOISY = [
  ['569933, Singapore 569933', [1.3496, 103.8494]],          // Google's way of writing a typed postal code
  ['Singapore 569933', [1.3496, 103.8494]],
  ['Swim class  @ pool,  S(569933)', [1.3496, 103.8494]],    // parentheses and double spaces
  ['Bishan Sports Hall, 5 Bishan St 14, Singapore 579783', [1.3550, 103.8510]], // unknown postal code, name found
  ['bishan sports hall', [1.3550, 103.8510]],
  ['Rue de la Loi 16, 1000 Bruxelles, Belgium', null],         // abroad: nothing
  ['Zoom link https://example.test/123456789', null],
];

for (const [text, want] of NOISY) {
  test(`find "${text}"`, async () => {
    _resetOneMapToken();
    const f = fakeFetch();
    const om = oneMap({ email: 'e', password: 'p', fetchImpl: f.impl });
    const got = await om.find(text);
    assert.deepEqual(got && [got.lat, got.lng], want);
    assert.ok(f.asked.length <= 3, 'at most 3 searches per location');
  });
}

test('stops at the first hit: a postal code costs one search', async () => {
  _resetOneMapToken();
  const f = fakeFetch();
  await oneMap({ email: 'e', password: 'p', fetchImpl: f.impl }).find('569933, Singapore 569933');
  assert.deepEqual(f.asked, ['569933']);
});
