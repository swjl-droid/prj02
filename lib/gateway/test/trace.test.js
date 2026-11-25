import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveMode, buildBatch, sendTrace, GATEWAY_VERSION } from '../trace.js';

const call = {
  purpose: 'test', model: 'claude-haiku-5-5', tenantId: '00000000-0000-0000-0000-000000000001',
  system: 'You help Mary.', messages: [{ role: 'user', content: 'My email is mary@x.io, I am Mary' }], names: ['Mary'],
};
const result = {
  ok: true, costUsd: 0.00035, latencyMs: 120, startedAt: '2026-11-25T01:00:00.000Z', endedAt: '2026-11-25T01:00:00.120Z',
  usage: { input_tokens: 1000, output_tokens: 500 },
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi Mary, noted mary@x.io' }] },
};
const ids = { traceId: 't1', generationId: 'g1', event1: 'e1', event2: 'e2' };
const json = (mode) => JSON.stringify(buildBatch({ mode, app: 'prj01', call, result, ids }));

test('mode rules: unknown or missing -> none; full only on preview', () => {
  assert.equal(effectiveMode(undefined, 'production'), 'none');
  assert.equal(effectiveMode('everything', 'preview'), 'none');
  assert.equal(effectiveMode(' Masked ', 'production'), 'masked');
  assert.equal(effectiveMode('full', 'production'), 'none');
  assert.equal(effectiveMode('full', undefined), 'none');
  assert.equal(effectiveMode('full', 'preview'), 'full');
});

test('none: no prompt, answer or name anywhere in what is sent', () => {
  const s = json('none');
  for (const secret of ['Mary', 'mary@x.io', 'You help', 'Hi ']) assert.ok(!s.includes(secret), secret);
  const b = JSON.parse(s).batch;
  assert.equal(b[0].body.metadata.costUsd, 0.00035);
  assert.equal(b[1].body.usageDetails.input, 1000);
  assert.equal(b[1].body.costDetails.total, 0.00035);
  assert.deepEqual(b.map((e) => e.type), ['trace-create', 'generation-create']);
});

test('masked: content is sent with names and emails masked', () => {
  const s = json('masked');
  assert.ok(!s.includes('Mary') && !s.includes('mary@x.io'));
  assert.ok(s.includes('My email is [EMAIL], I am [NAME]'));
  assert.ok(s.includes('Hi [NAME], noted [EMAIL]'));
});

test('full: content as is', () => {
  assert.ok(json('full').includes('My email is mary@x.io, I am Mary'));
});

test('sendTrace: accepted -> true; errors, refusal, timeout or missing keys -> false, never throws', async () => {
  const ok = async () => ({ ok: false, status: 207, json: async () => ({ successes: [{}, {}], errors: [] }) });
  const partial = async () => ({ ok: false, status: 207, json: async () => ({ successes: [{}], errors: [{ status: 403 }] }) });
  const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const boom = async () => { throw new Error('down'); };
  const args = { baseUrl: 'https://cloud.langfuse.com/', publicKey: 'pk', secretKey: 'sk', body: {} };
  assert.equal(await sendTrace({ ...args, fetchImpl: ok }), true);
  assert.equal(await sendTrace({ ...args, fetchImpl: partial }), false);
  assert.equal(await sendTrace({ ...args, fetchImpl: denied }), false);
  assert.equal(await sendTrace({ ...args, fetchImpl: boom }), false);
  assert.equal(await sendTrace({ ...args, secretKey: '', fetchImpl: ok }), false);
});

test('sendTrace posts to /api/public/ingestion with basic auth', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ errors: [] }) }; };
  await sendTrace({ baseUrl: 'https://cloud.langfuse.com/', publicKey: 'pk', secretKey: 'sk', body: { batch: [] }, fetchImpl: f });
  assert.equal(seen.url, 'https://cloud.langfuse.com/api/public/ingestion');
  assert.equal(seen.init.headers.authorization, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
});

test('every trace carries the gateway version tag (safeguard 4), read from VERSION', () => {
  const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  assert.equal(GATEWAY_VERSION, v);
  for (const mode of ['none', 'masked', 'full']) {
    const b = JSON.parse(json(mode)).batch;
    assert.ok(b[0].body.tags.includes(`gateway:${v}`), mode);
    assert.equal(b[1].body.metadata.gatewayVersion, v);
  }
});
