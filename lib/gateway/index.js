// LLM gateway: the one door every model call goes through (CLAUDE.md, "Cost and tracing").
// For each call it: refuses a model it cannot price, calls the Claude Messages API,
// writes one core.cost_ledger row (cost per call), sends one Langfuse trace (per TRACE_CONTENT),
// and returns the answer with what was logged.
//
// Plain English: like a company card terminal. Every purchase goes through it, the amount is
// written in the ledger, and a receipt (the trace) is filed, with personal details blacked out
// where the app's setting says so.
//
// Usage in an app:
//   import { createGateway } from '../lib/gateway/index.js';
//   const gateway = createGateway({ app: 'prj01' });
//   const { message, costUsd } = await gateway.call({
//     purpose: 'weekly-summary', model: 'claude-haiku-5-5', max_tokens: 500,
//     messages: [{ role: 'user', content: 'Hello' }],
//     tenantId, agentRunId, names: ['Mary'],   // names are masked in "masked" traces
//   });

import { randomUUID } from 'node:crypto';
import { priceFor, costUsd } from './pricing.js';
import { makeLedgerWriter } from './db.js';
import { effectiveMode, buildBatch, sendTrace, GATEWAY_VERSION } from './trace.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
const APPS = new Set(['prj01', 'prj02']);

export class GatewayError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.name = 'GatewayError';
    this.type = type;
    Object.assign(this, extra);
  }
}

/**
 * env defaults to process.env. Tests inject fetchImpl, writeLedger and env.
 * Nothing secret is ever logged: errors carry a type and an HTTP status, never a key or content.
 */
export function createGateway({ app, env = process.env, fetchImpl = fetch, writeLedger, timeoutMs = 60_000 } = {}) {
  if (!APPS.has(app)) throw new GatewayError('config', `Unknown app "${app}"`);
  const ledger = writeLedger ?? makeLedgerWriter(env.PLATFORM_DB_URL);
  const mode = effectiveMode(env.TRACE_CONTENT, env.VERCEL_ENV);

  async function call(req) {
    const { purpose, model, messages, system, max_tokens, tenantId = null, agentRunId = null, ...rest } = req ?? {};
    if (!purpose || typeof purpose !== 'string') throw new GatewayError('bad_request', 'purpose is required');
    if (!priceFor(model)) throw new GatewayError('unpriced_model', `Model "${model}" has no price in gateway/pricing.js`);
    if (!Array.isArray(messages) || messages.length === 0) throw new GatewayError('bad_request', 'messages are required');
    if (!Number.isInteger(max_tokens) || max_tokens <= 0) throw new GatewayError('bad_request', 'max_tokens is required');
    if (!env.ANTHROPIC_API_KEY) throw new GatewayError('config', 'ANTHROPIC_API_KEY is not set');
    const { names, ...apiExtras } = rest; // names are for masking only, never sent to the model API

    const ids = { traceId: randomUUID(), generationId: randomUUID(), event1: randomUUID(), event2: randomUUID() };
    const startedAt = new Date();
    let message = null;
    let errorType = null;
    let httpStatus = null;

    try {
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model, max_tokens, messages, ...(system ? { system } : {}), ...apiExtras }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = res.status;
      const json = await res.json().catch(() => null);
      if (res.ok && json?.type === 'message') message = json;
      else errorType = json?.error?.type ?? `http_${res.status}`;
    } catch (e) {
      errorType = e?.name === 'TimeoutError' ? 'timeout' : 'network';
    }

    const endedAt = new Date();
    const usage = message?.usage ?? {};
    const result = {
      ok: !!message,
      message,
      usage,
      costUsd: costUsd(model, usage), // a failed call is logged at 0 (Anthropic does not bill it)
      latencyMs: endedAt - startedAt,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      errorType,
      traceId: ids.traceId,
    };

    const traceBody = buildBatch({ mode, app, call: { purpose, model, system, messages, tenantId, agentRunId, names }, result, ids });

    // Ledger and trace run side by side; neither may hide the other's failure.
    const [ledgerOutcome, traceOk] = await Promise.all([
      ledger({
        app,
        tenant_id: tenantId,
        provider: 'anthropic',
        model,
        purpose,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        cost_usd: result.costUsd,
        latency_ms: result.latencyMs,
        agent_run_id: agentRunId,
        trace_id: ids.traceId,
        ok: result.ok,
      }).then(() => true, (e) => {
        // Log the kind of failure only (pg error code), never the URL or values.
        console.error(`[gateway] cost_ledger insert failed: ${e?.code ?? e?.name ?? 'error'}`);
        return false;
      }),
      sendTrace({
        baseUrl: env.LANGFUSE_BASE_URL,
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        body: traceBody,
        fetchImpl,
      }),
    ]);
    if (!traceOk) console.error('[gateway] Langfuse trace not accepted');

    result.logged = { ledger: ledgerOutcome, trace: traceOk, traceContent: mode, gatewayVersion: GATEWAY_VERSION };
    if (!result.ok) {
      throw new GatewayError(errorType, `Model call failed (${errorType})`, { status: httpStatus, result });
    }
    return result;
  }

  return { call, app, traceContent: mode, version: GATEWAY_VERSION };
}
