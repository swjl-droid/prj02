// The real helpers the bot logic uses in production: model calls through the gateway, Google
// Calendar through the bot's service account. Created on first use, so a missing setting only
// affects the feature that needs it (US-1 joining keeps working without GOOGLE_SA_KEY).
import { createGateway } from '../gateway/index.js';
import { googleCalendar } from '../calendar/google.js';
import { localParts } from '../calendar/dates.js';
import { interpret } from './interpret.js';
import { withRunLimits } from './limits.js';
import { interpretPlan } from './plan.js';

export function realDeps(cfg) {
  let gateway, google;
  const lazyGoogle = () => (google ??= googleCalendar());
  return {
    now: () => Date.now(),
    interpret: (text, { tenantId, timeZone }) => {
      gateway ??= createGateway({ app: 'prj02' });
      const p = localParts(timeZone);
      // One run per message: its own step and cost caps, and one Langfuse session (US-4).
      const run = withRunLimits(gateway, { maxSteps: cfg.runMaxSteps, maxCostUsd: cfg.runMaxCostUsd });
      return interpret(text, { gateway: run, model: cfg.calendarModel, today: p.date, now: p.time, weekday: p.weekday, timeZone, tenantId });
    },
    interpretPlan: (text, { trips, adults, timeZone, tenantId }) => {
      gateway ??= createGateway({ app: 'prj02' });
      const run = withRunLimits(gateway, { maxSteps: cfg.runMaxSteps, maxCostUsd: cfg.runMaxCostUsd });
      return interpretPlan(text, { gateway: run, model: cfg.planModel ?? cfg.calendarModel, trips, adults, timeZone, tenantId });
    },
    google: {
      list: (...a) => lazyGoogle().list(...a),
      insert: (...a) => lazyGoogle().insert(...a),
      patch: (...a) => lazyGoogle().patch(...a),
      remove: (...a) => lazyGoogle().remove(...a),
    },
  };
}
