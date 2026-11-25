import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { effectiveMode, buildBatch, sendTrace, newIds, OTEL_PATH, GATEWAY_VERSION } from '../trace.js';

const call = {
  purpose: 'test', model: 'claude-haiku-5-5', tenantId: '00000000-0000-0000-0000-000000000001',
  system: 'You help Mary.', messages: [{ role: 'user', content: 'My email is mary@x.io, I am Mary' }], names: ['Mary'],
};
const result = {
  ok: true, costUsd: 0.00035, latencyMs: 120, startedAt: '2026-11-25T01:00:00.000Z', endedAt: '2026-11-25T01:00:00.120Z',
  usage: { input_tokens: 1000, output_tokens: 500 },
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi Mary, noted mary@x.io' }] },
};
const ids = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
const body = (mode, r = result) => buildBatch({ mode, app: 'prj01', call, result: r, ids });
const span = (mode, r) => body(mode, r).resourceSpans[0].scopeSpans[0].spans[0];
const attrs = (mode, r) => Object.fromEntries(span(mode, r).attributes.map((a) => [a.key,
  a.value.stringValue ?? a.value.arrayValue?.values.map((v) => v.stringValue)]));

test('mode rules: unknown or missing -> none; full only on preview', () => {
  assert.equal(effectiveMode(undefined, 'production'), 'none');
  assert.equal(effectiveMode('everything', 'preview'), 'none');
  assert.equal(effectiveMode(' Masked ', 'production'), 'masked');
  assert.equal(effectiveMode('full', 'production'), 'none');
  assert.equal(effectiveMode('full', undefined), 'none');
  assert.equal(effectiveMode('full', 'preview'), 'full');
});

test('ids are OpenTelemetry-shaped: 32 and 16 hex characters', () => {
  const i = newIds(randomUUID);
  assert.match(i.traceId, /^[0-9a-f]{32}$/);
  assert.match(i.spanId, /^[0-9a-f]{16}$/);
});

test('one OTel span typed generation, with model, usage, cost, times and status', () => {
  const s = span('none');
  const a = attrs('none');
  assert.equal(s.traceId, ids.traceId);
  assert.equal(s.startTimeUnixNano, '1795568400000000000');
  assert.equal(s.endTimeUnixNano, '1795568400120000000');
  assert.deepEqual(s.status, { code: 1 });
  assert.equal(a['langfuse.observation.type'], 'generation');
  assert.equal(a['langfuse.trace.name'], 'prj01:test');
  assert.equal(a['langfuse.user.id'], call.tenantId);
  assert.equal(a['langfuse.observation.model.name'], 'claude-haiku-5-5');
  assert.deepEqual(JSON.parse(a['langfuse.observation.usage_details']),
    { input: 1000, output: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.deepEqual(JSON.parse(a['langfuse.observation.cost_details']), { total: 0.00035 });
  assert.equal(a['langfuse.observation.level'], 'DEFAULT');
  assert.equal(a['langfuse.trace.metadata.purpose'], 'test');
});

test('a failed call is marked ERROR with its error type', () => {
  const failed = { ...result, ok: false, message: null, errorType: 'overloaded_error', usage: {}, costUsd: 0 };
  assert.deepEqual(span('none', failed).status, { code: 2, message: 'overloaded_error' });
  assert.equal(attrs('none', failed)['langfuse.observation.level'], 'ERROR');
  assert.equal(attrs('none', failed)['langfuse.observation.status_message'], 'overloaded_error');
});

test('none: no prompt, answer or name anywhere in what is sent', () => {
  const s = JSON.stringify(body('none'));
  for (const secret of ['Mary', 'mary@x.io', 'You help', 'Hi ']) assert.ok(!s.includes(secret), secret);
  assert.equal(attrs('none')['langfuse.observation.input'], undefined);
  assert.equal(attrs('none')['langfuse.observation.output'], undefined);
});

test('masked: content is sent with names and emails masked', () => {
  const s = JSON.stringify(body('masked'));
  assert.ok(!s.includes('Mary') && !s.includes('mary@x.io'));
  assert.ok(attrs('masked')['langfuse.observation.input'].includes('My email is [EMAIL], I am [NAME]'));
  assert.ok(attrs('masked')['langfuse.observation.output'].includes('Hi [NAME], noted [EMAIL]'));
});

test('full: content as is', () => {
  assert.ok(attrs('full')['langfuse.observation.input'].includes('My email is mary@x.io, I am Mary'));
});

test('every trace carries the gateway version tag (safeguard 4), read from VERSION', () => {
  const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  assert.equal(GATEWAY_VERSION, v);
  for (const mode of ['none', 'masked', 'full']) {
    assert.ok(attrs(mode)['langfuse.trace.tags'].includes(`gateway:${v}`), mode);
    assert.equal(attrs(mode)['langfuse.trace.metadata.gatewayVersion'], v);
  }
});

test('sendTrace: accepted -> ok; refusal, rejected span, network error or missing keys -> not ok with a status, never throws', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const rejected = async () => ({ ok: true, status: 200, json: async () => ({ partialSuccess: { rejectedSpans: 1, errorMessage: 'x' } }) });
  const gone = async () => ({ ok: false, status: 410, json: async () => ({}) });
  const boom = async () => { throw new TypeError('fetch failed'); };
  const args = { baseUrl: 'https://cloud.langfuse.com/', publicKey: 'pk', secretKey: 'sk', body: {} };
  assert.deepEqual(await sendTrace({ ...args, fetchImpl: ok }), { ok: true, status: 200 });
  assert.deepEqual(await sendTrace({ ...args, fetchImpl: rejected }), { ok: false, status: 200, rejected: 1 });
  assert.deepEqual(await sendTrace({ ...args, fetchImpl: gone }), { ok: false, status: 410 });
  assert.deepEqual(await sendTrace({ ...args, fetchImpl: boom }), { ok: false, status: 'network' });
  assert.deepEqual(await sendTrace({ ...args, secretKey: '', fetchImpl: ok }), { ok: false, status: 'not_configured' });
});

test('sendTrace posts OTLP JSON to the OpenTelemetry endpoint with basic auth and the v4 header', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({}) }; };
  await sendTrace({ baseUrl: 'https://cloud.langfuse.com/', publicKey: 'pk', secretKey: 'sk', body: { resourceSpans: [] }, fetchImpl: f });
  assert.equal(seen.url, 'https://cloud.langfuse.com' + OTEL_PATH);
  assert.equal(OTEL_PATH, '/api/public/otel/v1/traces');
  assert.equal(seen.init.headers.authorization, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
  assert.equal(seen.init.headers['x-langfuse-ingestion-version'], '4');
  assert.equal(seen.init.headers['content-type'], 'application/json');
});
