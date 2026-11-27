// Settings (config/settings.json) and the values that come from the deployment.
import { readFileSync } from 'node:fs';

export const settings = JSON.parse(readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));

/** The production address, e.g. prj02.vercel.app (Vercel system variable; no secret). */
export function productionHost(env = process.env) {
  return env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || 'localhost';
}

export function botConfig({ botUsername, env = process.env }) {
  return {
    noticeVersion: settings.notice_version,
    noticeUrl: `https://${productionHost(env)}${settings.notice_path}`,
    inviteHours: settings.invite_hours,
    maxDisplayName: settings.max_display_name,
    calendarModel: settings.calendar_model,
    changeValidMinutes: settings.change_valid_minutes,
    defaultEventMinutes: settings.default_event_minutes,
    searchDays: settings.search_days,
    runMaxSteps: settings.run_max_steps,
    runMaxCostUsd: settings.run_max_cost_usd,
    stayGapMinutes: settings.stay_gap_minutes,
    planValidMinutes: settings.plan_valid_minutes,
    planModel: settings.plan_model,
    botUsername,
  };
}
