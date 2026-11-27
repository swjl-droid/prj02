// Drive time from OneMap (Singapore Land Authority), decision 'prj02 route time' (Hub row 134):
// OneMap only for a Singapore family when both ends resolve to a Singapore place; otherwise the
// caller uses the family's estimate. The access token comes from ONEMAP_EMAIL and ONEMAP_PASSWORD,
// is kept in memory only and renewed before it expires (Hub row 136: never stored).
//
// Plain English: ask OneMap "how long is the drive from home to the pool?"; if OneMap cannot
// tell, the bot uses the family's usual guess and says so ("est.").

const BASE = 'https://www.onemap.gov.sg';

export class RouteError extends Error {
  constructor(type, status) { super(`onemap ${type}`); this.type = type; this.status = status ?? null; }
}

let cached = null; // { token, until } in memory only

export function oneMap({ email = process.env.ONEMAP_EMAIL, password = process.env.ONEMAP_PASSWORD,
  fetchImpl = fetch, clock = () => Date.now() } = {}) {
  async function token() {
    if (cached && cached.until > clock() + 3600_000) return cached.token; // renew an hour early
    if (!email || !password) throw new RouteError('not_configured');
    const res = await fetchImpl(`${BASE}/api/auth/post/getToken`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new RouteError('auth_failed', res.status);
    const until = Number(data.expiry_timestamp) ? Number(data.expiry_timestamp) * 1000 : clock() + 3 * 86400_000;
    cached = { token: data.access_token, until };
    return cached.token;
  }

  return {
    /** First Singapore match for a postal code, address or place name, or null. */
    async find(text) {
      const q = String(text ?? '').trim().slice(0, 120);
      if (!q) return null;
      const url = new URL(`${BASE}/api/common/elastic/search`);
      url.search = new URLSearchParams({ searchVal: q, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' });
      const res = await fetchImpl(url, { headers: { authorization: await token() } });
      if (!res.ok) throw new RouteError('search_failed', res.status);
      const hit = (await res.json().catch(() => ({})))?.results?.[0];
      const lat = Number(hit?.LATITUDE); const lng = Number(hit?.LONGITUDE);
      if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      // Singapore's bounding box: anything outside is not a Singapore place.
      if (lat < 1.15 || lat > 1.48 || lng < 103.6 || lng > 104.1) return null;
      return { lat, lng };
    },
    /** Drive minutes between two points, rounded up. */
    async driveMinutes(from, to) {
      const url = new URL(`${BASE}/api/public/routingsvc/route`);
      url.search = new URLSearchParams({ start: `${from.lat},${from.lng}`, end: `${to.lat},${to.lng}`, routeType: 'drive' });
      const res = await fetchImpl(url, { headers: { authorization: await token() } });
      if (!res.ok) throw new RouteError('route_failed', res.status);
      const secs = Number((await res.json().catch(() => ({})))?.route_summary?.total_time);
      if (!Number.isFinite(secs) || secs <= 0) throw new RouteError('no_route');
      return Math.max(1, Math.ceil(secs / 60));
    },
  };
}

export function _resetOneMapToken() { cached = null; }
