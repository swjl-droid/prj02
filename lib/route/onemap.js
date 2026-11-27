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

  async function search(q) {
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
  }

  return {
    /**
     * First Singapore match for a postal code, address or place name, or null.
     * OneMap's search matches a bare postal code or a building / street name, but finds nothing
     * for the way Google Calendar writes a location ("Pool, Singapore 123456"). So it tries, in
     * order and stopping at the first hit: the 6-digit postal code, the text as typed, the part
     * before the first comma (gap 27/11, Hub row 276).
     */
    async find(text) {
      for (const q of searchTerms(text)) {
        const hit = await search(q);
        if (hit) return hit;
      }
      return null;
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

/** What to ask OneMap for a location, most precise first, without repeats (at most 3 searches). */
export function searchTerms(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!t) return [];
  const postal = t.match(/(?<![0-9])([0-9]{6})(?![0-9])/)?.[1];
  const head = t.split(',')[0].trim();
  return [...new Set([postal, t, head].filter((q) => q && q.length >= 2))];
}
