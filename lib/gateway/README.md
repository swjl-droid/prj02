# LLM gateway

The one door every model call goes through (CLAUDE.md, "Cost and tracing"). Version in `VERSION`.

| File | What it does |
|---|---|
| `index.js` | `createGateway({ app })` and `gateway.call(...)`: checks the request, calls the Claude Messages API, logs cost and trace |
| `pricing.js` | Price per model (source and date inside); a model without a price is refused |
| `db.js` | Writes one `core.cost_ledger` row as the app's insert-only role, with Supabase's certificate checked |
| `trace.js` | One Langfuse trace per call, content set by `TRACE_CONTENT` (`none` / `masked` / `full`) |
| `mask.js` | Masks emails, phones, NRIC / FIN and the given names the app passes in |
| `stamp.mjs` | Checks an app's copy against its `STAMP.json` |
| `supabase-root-2021.crt` | Supabase Root 2021 CA, the only authority the database connection trusts |
| `test/` | Unit tests (`npm test` in ai-platform; apps run them on their copy) |

## Use in an app

```js
import { createGateway } from '../lib/gateway/index.js';

const gateway = createGateway({ app: 'prj01' });          // reads the app's Vercel settings
const result = await gateway.call({
  purpose: 'weekly-summary',                               // short label, shows in the ledger and Langfuse
  model: 'claude-haiku-5-5',
  max_tokens: 500,
  messages: [{ role: 'user', content: 'Summarise my week' }],
  tenantId,                                                // uuid of the family / organisation, or null
  agentRunId,                                              // core.agent_runs id, or null
  names: ['Mary'],                                         // given names to mask in "masked" traces
});
// result.message      the model's answer (Messages API format)
// result.costUsd      what the call cost, as written in core.cost_ledger
// result.logged       { ledger: true|false, trace: true|false, traceContent: 'none'|'masked'|'full' }
```

A failed model call is still logged (`ok = false`, cost 0) and then thrown as a `GatewayError`
with a `type` (for example `overloaded_error`, `timeout`, `unpriced_model`).

## Settings it reads (Vercel, per app)

`ANTHROPIC_API_KEY`, `PLATFORM_DB_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
`TRACE_CONTENT`, and `VERCEL_ENV` (set by Vercel; `full` traces only on `preview`).

## Changing it

Change files here, bump `VERSION`, merge, then copy into the apps:
`node scripts/gateway/open-copy-prs.mjs <work-dir>`. Never edit a copy inside an app.
