// Sends one Langfuse trace per model call (decision 23/11/2026, Hub row 193).
// What the trace may contain is set per app by TRACE_CONTENT:
//   none   - cost, tokens, timing, status, error type and run id only (prj02, children's data)
//   masked - prompt and answer with emails, phones, NRIC and given names masked (prj01)
//   full   - everything, only on preview deployments with made-up test data
// Missing or unknown -> none. "full" on production -> none (never sends real content unmasked).
// A trace that fails to send never fails the model call: the key may lack rights or have expired
// (renewal: Hub row 207), and the answer matters more than its trace.

import { readFileSync } from 'node:fs';
import { maskDeep } from './mask.js';

// Gateway version, shown as tag gateway:<version> on every trace (safeguard 4, decision 25/11/2026):
// a trace still showing the old version after a release means that app's copy is not live yet.
export const GATEWAY_VERSION = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();

const MODES = new Set(['none', 'masked', 'full']);

/** The content mode actually used, after the safety rules above. */
export function effectiveMode(setting, vercelEnv) {
  const mode = MODES.has(String(setting ?? '').trim().toLowerCase())
    ? String(setting).trim().toLowerCase()
    : 'none';
  if (mode === 'full' && vercelEnv !== 'preview') return 'none';
  return mode;
}

/** Builds the Langfuse ingestion batch for one call. Pure: no network, easy to test. */
export function buildBatch({ mode, app, call, result, ids, now = () => new Date().toISOString() }) {
  const withContent = mode === 'masked' || mode === 'full';
  const content = (v) => (mode === 'full' ? v : mode === 'masked' ? maskDeep(v, call.names ?? []) : undefined);

  const input = withContent ? content({ system: call.system, messages: call.messages }) : undefined;
  const output = withContent && result.message ? content(result.message.content) : undefined;

  const metadata = {
    app,
    gatewayVersion: GATEWAY_VERSION,
    purpose: call.purpose,
    traceContent: mode,
    agentRunId: call.agentRunId ?? null,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ok: result.ok,
    errorType: result.errorType ?? null,
    stopReason: result.message?.stop_reason ?? null,
  };

  return {
    batch: [
      {
        id: ids.event1,
        timestamp: now(),
        type: 'trace-create',
        body: {
          id: ids.traceId,
          name: `${app}:${call.purpose}`,
          timestamp: result.startedAt,
          userId: call.tenantId ?? undefined, // a uuid, never a name: lets John find a person's traces
          sessionId: call.agentRunId ?? undefined,
          tags: [app, call.purpose, `content:${mode}`, `gateway:${GATEWAY_VERSION}`],
          metadata,
          input,
          output,
        },
      },
      {
        id: ids.event2,
        timestamp: now(),
        type: 'generation-create',
        body: {
          id: ids.generationId,
          traceId: ids.traceId,
          name: call.purpose,
          model: call.model,
          startTime: result.startedAt,
          endTime: result.endedAt,
          input,
          output,
          usageDetails: {
            input: result.usage.input_tokens ?? 0,
            output: result.usage.output_tokens ?? 0,
            cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
          },
          costDetails: { total: result.costUsd },
          level: result.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: result.ok ? undefined : result.errorType,
          metadata,
        },
      },
    ],
  };
}

/** Posts the batch to Langfuse. Resolves true when Langfuse accepted both events, false otherwise. */
export async function sendTrace({ baseUrl, publicKey, secretKey, body, fetchImpl = fetch, timeoutMs = 3000 }) {
  if (!baseUrl || !publicKey || !secretKey) return false;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 207) return false;
    const json = await res.json().catch(() => ({}));
    return !(Array.isArray(json.errors) && json.errors.length > 0);
  } catch {
    return false;
  }
}
