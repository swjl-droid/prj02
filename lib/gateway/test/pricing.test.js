import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, priceFor, MODELS } from '../pricing.js';

test('Haiku 5.5: 1,000 in + 500 out = $0.00035', () => {
  // 1000 x 0.10/1M + 500 x 0.50/1M = 0.0001 + 0.00025
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 500 }), 0.00035);
});

test('Opus 5.5 with cache read and 5-minute cache write', () => {
  // 2000 x 4 + 1000 x 20 + 10000 x 0.20 + 4000 x 5 (=4 x 1.25), all per million
  const c = costUsd('claude-opus-5-5', {
    input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 4000,
  });
  assert.equal(c, 0.05);
});

test('1-hour cache write costs twice the input price', () => {
  const c = costUsd('claude-sonnet-5-5', {
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
  });
  assert.equal(c, 4);
});

test('Haiku 5.5 prompt over 100,000 tokens costs 5 times more', () => {
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 100_000 }), 0.01);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1000 }), 0.1025); // 200000 x 0.50 + 1000 x 2.50, per million
});

test('dated model ids are priced, unknown models are refused', () => {
  assert.equal(priceFor('claude-haiku-5-5-20261007').id, 'claude-haiku-5-5');
  assert.equal(priceFor('claude-haiku-5-50'), null);
  assert.equal(priceFor('gpt-x'), null);
  assert.throws(() => costUsd('gpt-x', {}), /No price/);
});

test('missing or negative usage counts as zero', () => {
  assert.equal(costUsd('claude-haiku-5-5', {}), 0);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: -5, output_tokens: null }), 0);
});

test('every model has input, output and cache-read prices', () => {
  for (const [id, p] of Object.entries(MODELS)) {
    for (const k of ['input', 'output', 'cacheRead']) assert.ok(p[k] > 0, `${id}.${k}`);
  }
});
