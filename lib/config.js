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
    botUsername,
  };
}
