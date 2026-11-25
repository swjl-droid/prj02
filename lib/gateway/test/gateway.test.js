import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, ANTHROPIC_URL } from '../index.js';
import { GATEWAY_VERSION } from '../trace.js';

const FAKE_KEY = 'test-key-not-real';
const env = (over = {}) => ({
  ANTHROPIC_API_KEY: FAKE_KEY, LANGFUSE_BASE_URL: 'https://lf.test', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk',
  TRACE_CONTENT: 'none', VERCEL_ENV: 'production', ...over,
});
const anthropicOk = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello Mary' }],
  usage: { input_tokens: 1000, output_tokens: 500 } };

function fakes({ anthropic = { status: 200, body: anthropicOk }, langfuse = { status: 207, body: { errors: [] } }, ledgerFails = false } = {}) {
  const calls = { anthropic: [], langfuse: [], ledger: [] };
  const fetchImpl = async (url, init) => {
    if (url === ANTHROPIC_URL) {
      calls.anthropic.push(init);
      if (anthropic === 'network') throw new TypeError('fetch failed');
      return { ok: anthropic.status < 300, status: anthropic.status, json: async () => anthropic.body };
    }
    calls.langfuse.push({ url, init });
    return { ok: langfuse.status < 300, status: langfuse.status, json: async () => langfuse.body };
  };
  const writeLedger = async (row) => { calls.ledger.push(row); if (ledgerFails) throw Object.assign(new Error('x'), { code: '42501' }); };
  return { calls, fetchImpl, writeLedger };
}
const req = { purpose: 'smoke', model: 'claude-haiku-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'Hi, I am Mary' }],
  tenantId: '00000000-0000-0000-0000-000000000001', names: ['Mary'] };

test('a call writes one cost row and one trace, and returns the answer', async () => {
  const f = fakes();
  const gw = createGateway({ app: 'prj01', env: env(), ...f });
  const r = await gw.call(req);
  assert.equal(r.message.content[0].text, 'Hello Mary');
  assert.equal(r.costUsd, 0.00035);
  assert.deepEqual(r.logged, { ledger: true, trace: true, traceContent: 'none', gatewayVersion: GATEWAY_VERSION });
  assert.equal(f.calls.ledger.length, 1);
  const row = f.calls.ledger[0];
  assert.equal(row.app, 'prj01');
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.cost_usd, 0.00035);
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.trace_id, r.traceId);
  assert.equal(row.ok, true);
  assert.equal(f.calls.langfuse.length, 1);
});

test('names are not sent to the model API; the key goes only in its header', async () => {
  const f = fakes();
  await createGateway({ app: 'prj01', env: env(), ...f }).call(req);
  const body = JSON.parse(f.calls.anthropic[0].body);
  assert.equal(body.names, undefined);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(f.calls.anthropic[0].headers['x-api-key'], FAKE_KEY);
  assert.ok(!JSON.stringify(f.calls.ledger).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(f.calls.langfuse).includes(FAKE_KEY));
});

test('prj02 setting none: the trace holds no content', async () => {
  const f = fakes();
  await createGateway({ app: 'prj02', env: env({ TRACE_CONTENT: 'none' }), ...f }).call(req);
  const sent = f.calls.langfuse[0].init.body;
  assert.ok(!sent.includes('Mary') && !sent.includes('Hi, I am'));
});

test('a model without a price is refused before any call or log', async () => {
  const f = fakes();
  const gw = createGateway({ app: 'prj01', env: env(), ...f });
  await assert.rejects(gw.call({ ...req, model: 'claude-unknown-9' }), { type: 'unpriced_model' });
  assert.equal(f.calls.anthropic.length + f.calls.ledger.length + f.calls.langfuse.length, 0);
});

test('a failed model call is still logged (ok false, cost 0) and then raised', async () => {
  const f = fakes({ anthropic: { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } } });
  const gw = createGateway({ app: 'prj01', env: env(), ...f });
  await assert.rejects(gw.call(req), (e) => e.type === 'overloaded_error' && e.status === 529);
  assert.equal(f.calls.ledger[0].ok, false);
  assert.equal(f.calls.ledger[0].cost_usd, 0);
  assert.equal(f.calls.langfuse.length, 1);
});

test('a network failure is logged as type network', async () => {
  const f = fakes({ anthropic: 'network' });
  await assert.rejects(createGateway({ app: 'prj01', env: env(), ...f }).call(req), { type: 'network' });
  assert.equal(f.calls.ledger[0].ok, false);
});

test('ledger or Langfuse failures do not lose the answer; they are reported in logged', async () => {
  const f = fakes({ ledgerFails: true, langfuse: { status: 401, body: {} } });
  const r = await createGateway({ app: 'prj01', env: env(), ...f }).call(req);
  assert.equal(r.message.content[0].text, 'Hello Mary');
  assert.deepEqual(r.logged, { ledger: false, trace: false, traceContent: 'none', gatewayVersion: GATEWAY_VERSION });
});

test('bad input and missing settings are refused', async () => {
  const f = fakes();
  assert.throws(() => createGateway({ app: 'prj03', env: env(), ...f }), { type: 'config' });
  const gw = createGateway({ app: 'prj01', env: env(), ...f });
  await assert.rejects(gw.call({ ...req, purpose: '' }), { type: 'bad_request' });
  await assert.rejects(gw.call({ ...req, max_tokens: undefined }), { type: 'bad_request' });
  await assert.rejects(gw.call({ ...req, messages: [] }), { type: 'bad_request' });
  const noKey = createGateway({ app: 'prj01', env: env({ ANTHROPIC_API_KEY: '' }), ...f });
  await assert.rejects(noKey.call(req), { type: 'config' });
});
