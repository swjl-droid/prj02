// Limits of one model run (prj02-R1 US-4, the L2 limits decided at BS-2): at most run_max_steps
// model calls and run_max_cost_usd per run, checked BEFORE each call with the worst case of that
// call (its prompt size and max_tokens), so a run can never spend past its cap. Every call of a
// run carries the run id, so Langfuse shows the run as one session (traces carry no content).
//
// Plain English: a pocket-money envelope per errand; the bot checks the envelope before it buys.
import { randomUUID } from 'node:crypto';
import { costUsd } from '../gateway/pricing.js';

export class LimitError extends Error {
  constructor(kind) { super(`limit ${kind}`); this.type = `limit:${kind}`; this.kind = kind; }
}

/**
 * An upper bound of a call's input tokens: 1 token per character of everything sent (English is
 * about 4 characters a token; Chinese about 1, so this holds for both).
 */
export function worstInputTokens(req) {
  return JSON.stringify([req.system ?? '', req.messages ?? [], req.tools ?? []]).length;
}

export function withRunLimits(gateway, { maxSteps, maxCostUsd, runId = randomUUID() }) {
  if (!(maxSteps >= 1) || !(maxCostUsd > 0)) throw new LimitError('not_configured');
  const used = { steps: 0, costUsd: 0 };
  return {
    runId,
    used,
    async call(req) {
      if (used.steps >= maxSteps) throw new LimitError('steps');
      const worst = costUsd(req.model, { input_tokens: worstInputTokens(req), output_tokens: req.max_tokens });
      if (used.costUsd + worst > maxCostUsd) throw new LimitError('cost');
      used.steps++;
      const r = await gateway.call({ ...req, agentRunId: runId });
      used.costUsd += Number(r?.costUsd) || 0;
      return r;
    },
  };
}
