// Model prices in US dollars per million tokens (Claude API, standard rates, global routing).
// Source: Anthropic pricing page and launch notes, checked 25/11/2026.
// Only models listed here may be called: the gateway refuses a model it cannot price,
// so no call is ever logged at a made-up cost. Add a model here (with its source) before using it.
//
// Plain English: a "token" is a word-piece; prices are per million of them.
// Cache write = sending text the model keeps ready for reuse; cache read = reusing it (much cheaper).

export const PRICES_CHECKED_ON = '2026-11-25';

// Multipliers on the base input price (Anthropic's published rules).
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

export const MODELS = {
  'claude-opus-5-5':   { input: 4,    output: 20,  cacheRead: 0.20 },
  'claude-sonnet-5-5': { input: 2,    output: 10,  cacheRead: 0.10 },
  // Haiku 5.5: prompts over 100,000 tokens cost 5 times more (input, output and cache).
  'claude-haiku-5-5':  { input: 0.10, output: 0.50, cacheRead: 0.01,
                         longPrompt: { overTokens: 100_000, factor: 5 } },
};

/** Returns the price row for a model id, accepting dated ids such as claude-haiku-5-5-20261007. */
export function priceFor(model) {
  if (typeof model !== 'string') return null;
  for (const [id, row] of Object.entries(MODELS)) {
    if (model === id || model.startsWith(id + '-')) return { id, ...row };
  }
  return null;
}

/**
 * Cost in US dollars of one call, from the usage block the Messages API returns.
 * usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *          cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }
 */
export function costUsd(model, usage = {}) {
  const p = priceFor(model);
  if (!p) throw new Error(`No price for model "${model}"`);
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const cacheRead = n(usage.cache_read_input_tokens);
  const cacheWriteTotal = n(usage.cache_creation_input_tokens);
  const w1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  // Anything not reported as 1-hour cache is priced as the 5-minute cache (the default).
  const w5m = Math.max(cacheWriteTotal - w1h, n(usage.cache_creation?.ephemeral_5m_input_tokens));

  let factor = 1;
  const promptTokens = input + cacheRead + cacheWriteTotal;
  if (p.longPrompt && promptTokens > p.longPrompt.overTokens) factor = p.longPrompt.factor;

  const perToken = (perMillion) => (perMillion * factor) / 1_000_000;
  const cost =
    input * perToken(p.input) +
    output * perToken(p.output) +
    cacheRead * perToken(p.cacheRead) +
    w5m * perToken(p.input * CACHE_WRITE_5M) +
    w1h * perToken(p.input * CACHE_WRITE_1H);
  // core.cost_ledger.cost_usd is numeric(12, 6): round to the micro-dollar.
  return Math.round(cost * 1e6) / 1e6;
}
