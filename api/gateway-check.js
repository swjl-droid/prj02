// Gateway check (step 5.5, AIP-W1 US-7 / US-9): one tiny real model call through the gateway,
// which writes one core.cost_ledger row and one Langfuse trace. Previews only: production answers
// 404, so nobody can spend money through it. Previews are behind Vercel Authentication.
import { createGateway } from '../lib/gateway/index.js';

export async function GET() {
  if (process.env.VERCEL_ENV !== 'preview') return new Response('Not found', { status: 404 });
  const gateway = createGateway({ app: 'prj02' });
  try {
    const r = await gateway.call({
      purpose: 'gateway-check',
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    return Response.json({
      ok: true, app: 'prj02', region: process.env.VERCEL_REGION ?? 'local',
      answer: r.message.content.find((c) => c.type === 'text')?.text ?? '',
      model: r.message.model, usage: r.usage, costUsd: r.costUsd, latencyMs: r.latencyMs,
      traceId: r.traceId, logged: r.logged,
    });
  } catch (e) {
    // Error kind only: never a key or a connection string.
    return Response.json({ ok: false, app: 'prj02', errorType: e.type ?? e.name, status: e.status ?? null,
      logged: e.result?.logged ?? null }, { status: 502 });
  }
}
