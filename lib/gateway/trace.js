// Sends one Langfuse trace per model call (decision 23/11/2026, Hub row 193).
// What the trace may contain is set per app by TRACE_CONTENT:
//   none   - cost, tokens, timing, status, error type and run id only (prj02, children's data)
//   masked - prompt and answer with emails, phones, NRIC and given names masked (prj01)
//   full   - everything, only on preview deployments with made-up test data
// Missing or unknown -> none. "full" on production -> none (never sends real content unmasked).
// A trace that fails to send never fails the model call: the key may lack rights or have expired
// (renewal: Hub row 207), and the answer matters more than its trace.
//
// Format: OpenTelemetry (OTLP/HTTP, JSON) to /api/public/otel/v1/traces. Langfuse Cloud switched off
// its older ingestion API on 16/11/2026 (found in the first live call, 25/11/2026). One OTel span per
// call, typed as a Langfuse "generation", carrying the trace's name, user, tags and metadata.
// Plain English: the same receipt, written on the new standard form Langfuse now accepts.

import { readFileSync } from 'node:fs';
import { maskDeep } from './mask.js';

// Gateway version, shown as tag gateway:<version> on every trace (safeguard 4, decision 25/11/2026):
// a trace still showing the old version after a release means that app's copy is not live yet.
export const GATEWAY_VERSION = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();

export const OTEL_PATH = '/api/public/otel/v1/traces';
const MODES = new Set(['none', 'masked', 'full']);

/** The content mode actually used, after the safety rules above. */
export function effectiveMode(setting, vercelEnv) {
  const mode = MODES.has(String(setting ?? '').trim().toLowerCase())
    ? String(setting).trim().toLowerCase()
    : 'none';
  if (mode === 'full' && vercelEnv !== 'preview') return 'none';
  return mode;
}

/** New ids: OTel trace id = 32 hex characters, span id = 16. The trace id is also stored in core.cost_ledger. */
export function newIds(randomUUID) {
  return {
    traceId: randomUUID().replaceAll('-', ''),
    spanId: randomUUID().replaceAll('-', '').slice(0, 16),
  };
}

const nanos = (iso) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

function attr(key, value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } };
  return { key, value: { stringValue: String(value) } };
}

/** Builds the OTLP/JSON body for one call. Pure: no network, easy to test. */
export function buildBatch({ mode, app, call, result, ids }) {
  const withContent = mode === 'masked' || mode === 'full';
  const content = (v) => (mode === 'full' ? v : maskDeep(v, call.names ?? []));
  const input = withContent ? JSON.stringify(content({ system: call.system, messages: call.messages })) : undefined;
  const output = withContent && result.message ? JSON.stringify(content(result.message.content)) : undefined;

  const metadata = {
    app,
    gatewayVersion: GATEWAY_VERSION,
    purpose: call.purpose,
    traceContent: mode,
    agentRunId: call.agentRunId ?? undefined,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ok: result.ok,
    errorType: result.errorType ?? undefined,
    stopReason: result.message?.stop_reason ?? undefined,
  };
  const meta = (prefix) => Object.entries(metadata).map(([k, v]) => attr(`${prefix}.${k}`, v));

  const attributes = [
    attr('langfuse.observation.type', 'generation'),
    attr('langfuse.trace.name', `${app}:${call.purpose}`),
    attr('langfuse.user.id', call.tenantId ?? undefined), // a uuid, never a name: lets John find a person's traces
    attr('langfuse.session.id', call.agentRunId ?? undefined),
    attr('langfuse.trace.tags', [app, call.purpose, `content:${mode}`, `gateway:${GATEWAY_VERSION}`]),
    attr('langfuse.version', GATEWAY_VERSION),
    attr('langfuse.observation.model.name', call.model),
    attr('langfuse.observation.usage_details', JSON.stringify({
      input: result.usage.input_tokens ?? 0,
      output: result.usage.output_tokens ?? 0,
      cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
    })),
    attr('langfuse.observation.cost_details', JSON.stringify({ total: result.costUsd })),
    attr('langfuse.observation.level', result.ok ? 'DEFAULT' : 'ERROR'),
    attr('langfuse.observation.status_message', result.ok ? undefined : result.errorType),
    attr('langfuse.observation.input', input),
    attr('langfuse.observation.output', output),
    ...meta('langfuse.trace.metadata'),
    ...meta('langfuse.observation.metadata'),
  ].filter(Boolean);

  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', app)] },
      scopeSpans: [{
        scope: { name: 'ai-platform-gateway', version: GATEWAY_VERSION },
        spans: [{
          traceId: ids.traceId,
          spanId: ids.spanId,
          name: call.purpose,
          kind: 3, // client: the gateway calls the model API
          startTimeUnixNano: nanos(result.startedAt),
          endTimeUnixNano: nanos(result.endedAt),
          attributes,
          status: result.ok ? { code: 1 } : { code: 2, message: result.errorType ?? 'error' },
        }],
      }],
    }],
  };
}

/**
 * Posts the span to Langfuse. Resolves { ok, status } and never throws: ok is true when Langfuse
 * accepted it (2xx and no rejected span). status is the HTTP status (or 'timeout' / 'network'),
 * logged by the gateway so a refusal can be diagnosed without any content.
 */
export async function sendTrace({ baseUrl, publicKey, secretKey, body, fetchImpl = fetch, timeoutMs = 3000 }) {
  if (!baseUrl || !publicKey || !secretKey) return { ok: false, status: 'not_configured' };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${OTEL_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-langfuse-ingestion-version': '4',
        authorization: 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => ({}));
    const rejected = Number(json?.partialSuccess?.rejectedSpans ?? 0);
    return rejected > 0 ? { ok: false, status: res.status, rejected } : { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
