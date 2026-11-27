// Google Calendar for the bot (decision 27/11/2026: the bot's own Google service account; each
// family shares its calendar with it). Signs in with the service account key (GOOGLE_SA_KEY) and
// reads or writes events of one shared calendar. No Google library: a signed token and 4 calls.
//
// Plain English: the bot has its own Google account; the family invited it to their calendar
// like a person; this file is the bot opening that calendar.

import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';

export class CalendarError extends Error {
  constructor(type, status) {
    super(`calendar ${type}`);
    this.type = type; // kind only: never event content or the key
    this.status = status ?? null;
  }
}

/** Reads the key JSON from the setting; checks the fields it needs. */
export function readKey(json) {
  if (!json) throw new CalendarError('not_configured');
  let k;
  try { k = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new CalendarError('bad_key'); }
  if (!k.client_email || !k.private_key) throw new CalendarError('bad_key');
  return { email: k.client_email, privateKey: k.private_key, tokenUri: k.token_uri || 'https://oauth2.googleapis.com/token' };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A signed request for an access token (JWT bearer, RS256). */
export function signedAssertion(key, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.email, scope: SCOPE, aud: key.tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.privateKey))}`;
}

let cached = null; // { token, until } kept in memory only

export function googleCalendar({ keyJson = process.env.GOOGLE_SA_KEY, fetchImpl = fetch, clock = () => Date.now() } = {}) {
  const key = readKey(keyJson);

  async function token() {
    if (cached && cached.email === key.email && cached.until > clock() + 60_000) return cached.token;
    const res = await fetchImpl(key.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedAssertion(key, Math.floor(clock() / 1000)),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new CalendarError('auth_failed', res.status);
    cached = { email: key.email, token: data.access_token, until: clock() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  async function call(method, path, { query, body } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const type = res.status === 404 ? 'not_found' : res.status === 403 ? 'not_shared' : res.status === 410 ? 'gone' : 'api_error';
      throw new CalendarError(type, res.status);
    }
    return data;
  }

  const cal = (id) => `/calendars/${encodeURIComponent(id)}/events`;

  return {
    serviceAccountEmail: key.email,
    /** Events between two instants (ISO), single events expanded, in start order. */
    async list(calendarId, timeMin, timeMax) {
      const data = await call('GET', cal(calendarId), {
        query: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 100 },
      });
      return (data?.items ?? []).filter((e) => e.status !== 'cancelled');
    },
    insert: (calendarId, event) => call('POST', cal(calendarId), { body: event }),
    patch: (calendarId, eventId, fields) => call('PATCH', `${cal(calendarId)}/${encodeURIComponent(eventId)}`, { body: fields }),
    remove: (calendarId, eventId) => call('DELETE', `${cal(calendarId)}/${encodeURIComponent(eventId)}`),
  };
}

/** Test hook: forget the cached token. */
export function _resetTokenCache() { cached = null; }
