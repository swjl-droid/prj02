// Database access for the bot (decision Hub row 249, option A): role app_prj02_bot over the
// Supabase shared pooler (APP_DB_URL), with Supabase's certificate checked exactly as the gateway
// does (lib/gateway/db.js connectionConfig: sslmode in the URL is ignored, the pinned root only).
//
// One message = one transaction: begin_request() tells the database which Telegram account sent
// it, and every read and change in that transaction is limited to that person's family by RLS.
//
// Plain English: for each message the bot opens a fresh visitor badge at the database's front
// desk, does its work with that badge, then hands it back.

import pg from 'pg';
import { connectionConfig } from './gateway/db.js';

const pools = new Map();
function getPool(url, name = 'APP_DB_URL') {
  if (!url) throw new Error(`${name} is not set`);
  if (!pools.has(url)) pools.set(url, new pg.Pool(connectionConfig(url)));
  return pools.get(url);
}

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0]?.r ?? null;

/** The store the bot logic uses, bound to one transaction. */
export function storeFor(client) {
  return {
    open: (channel, account) => one(client, 'select app_prj02.begin_request($1, $2) as r', [channel, account]),
    previewInvite: (code) => one(client, 'select app_prj02.preview_invite($1) as r', [code]),
    acceptInvite: (code, channel, account, name, version) =>
      one(client, 'select app_prj02.accept_invite($1, $2, $3, $4, $5) as r', [code, channel, account, name, version]),
    recordConsent: (version) => one(client, 'select app_prj02.record_consent($1) as r', [version]),
    createInvite: (hours) => one(client, 'select app_prj02.create_invite($1) as r', [hours]),
    forgetMe: () => one(client, 'select app_prj02.forget_me() as r'),
    noteRefusal: (channel) => client.query('select app_prj02.note_refusal($1)', [channel]),
    // Calendar (prj02-R1 US-2): reads go through RLS, changes through the functions.
    calendar: async () => (await client.query(
      "select external_id, time_zone from app_prj02.calendars where provider = 'google' limit 1")).rows[0] ?? null,
    proposeChange: (action, eventId, proposal, minutes) =>
      one(client, 'select app_prj02.propose_change($1, $2, $3, $4) as r', [action, eventId, JSON.stringify(proposal), minutes]),
    decideChange: (id, yes) => one(client, 'select app_prj02.decide_change($1, $2) as r', [id, yes]),
    recordResult: (id, ok, eventId, error) =>
      one(client, 'select app_prj02.record_result($1, $2, $3, $4) as r', [id, ok, eventId, error]),
    // Trips (prj02-R1 US-3): an adult's tap assigns; reads go through RLS.
    people: async () => (await client.query(
      "select id, display_name from app_prj02.people where role = 'adult' order by created_at")).rows,
    trip: async (id) => (await client.query('select * from app_prj02.trips where id = $1', [id])).rows[0] ?? null,
    trips: async (from, to) => (await client.query(
      "select * from app_prj02.trips where event_start >= $1 and event_start < $2 and status <> 'cancelled' order by event_start", [from, to])).rows,
    assignTrips: (choices) => one(client, 'select app_prj02.assign_trips($1) as r', [JSON.stringify(choices)]),
    clashOptions: (reminderId) => one(client, 'select app_prj02.clash_options($1) as r', [reminderId]),
    // Limits and guards (prj02-R1 US-4).
    setPause: (on) => one(client, 'select app_prj02.set_pause($1) as r', [on]),
    budget: () => one(client, 'select app_prj02.budget() as r'),
    releaseTrip: (trip) => one(client, 'select app_prj02.release_trip($1) as r', [trip]),
    // Own plan for a clash (prj02-R1 US-6): only through the functions.
    planAwait: (clash, minutes) => one(client, 'select app_prj02.plan_await($1, $2) as r', [clash, minutes]),
    planPending: () => one(client, 'select app_prj02.plan_pending() as r'),
    planPropose: (plan, proposal) => one(client, 'select app_prj02.plan_propose($1, $2) as r', [plan, JSON.stringify(proposal)]),
    planDecide: (plan, yes) => one(client, 'select app_prj02.plan_decide($1, $2) as r', [plan, yes]),
    // Children (US-7): read through RLS, changed only through the functions.
    children: async () => (await client.query('select id, name, aliases from app_prj02.children order by created_at')).rows,
    childSave: (name, aliases) => one(client, 'select app_prj02.child_save($1, $2) as r', [name, aliases]),
    childRemove: (name) => one(client, 'select app_prj02.child_remove($1) as r', [name]),
    resolveUnknown: (trip, child) => one(client, 'select app_prj02.resolve_unknown($1, $2) as r', [trip, child]),
    familySettings: async () => (await client.query('select * from app_prj02.family_settings limit 1')).rows[0] ?? null,
    adultChats: async () => (await client.query(`select p.id as person_id, c.external_id as chat
      from app_prj02.people p join app_prj02.contacts c on c.person_id = p.id and c.channel = 'telegram'
      where p.role = 'adult'`)).rows,
  };
}

/**
 * The scheduler's store (role app_prj02_job, JOB_DB_URL; decision 'Scheduler gets its own database
 * role'). begin(family) opens the job; every later call reaches only that family.
 */
export function jobStoreFor(client) {
  const rows = async (sql, params) => (await client.query(sql, params)).rows;
  return {
    families: async () => (await rows('select app_prj02.job_families() as id')).map((r) => r.id),
    begin: async (family) => (await one(client, 'select app_prj02.begin_job($1) as r', [family])) === true,
    load: async () => {
      const [f] = await rows('select id, country from app_prj02.families');
      const [s] = await rows('select * from app_prj02.family_settings');
      const [c] = await rows("select external_id, time_zone from app_prj02.calendars where provider = 'google'");
      const adults = await rows(`select p.id as person_id, p.display_name, p.can_drive, c.external_id as chat
        from app_prj02.people p left join app_prj02.contacts c on c.person_id = p.id and c.channel = 'telegram'
        where p.role = 'adult' order by p.created_at`);
      const modes = Object.fromEntries((await rows('select mode, route, estimate_min, lead_min from app_prj02.travel_modes'))
        .map((m) => [m.mode, { route: m.route, estimate_min: m.estimate_min, lead_min: m.lead_min }]));
      // US-7: the family's convention (the family row; per-person rows come later) and children.
      const [convention] = await rows('select kind, separator from app_prj02.calendar_conventions where person_id is null');
      const children = await rows('select id, name, aliases, updated_at from app_prj02.children order by created_at');
      if (!f || !s || !c) return null;
      return { family_id: f.id, country: f.country, settings: s, calendar_id: c.external_id, time_zone: c.time_zone,
        home: s.home_lat != null && s.home_lng != null ? { lat: s.home_lat, lng: s.home_lng } : null, adults, modes,
        convention: convention ?? null, children };
    },
    // Saved places, one per place and route: key 'route|place'.
    places: async () => new Map((await rows('select label_key, route, lat, lng, drive_min, source from app_prj02.places'))
      .map((r) => [`${r.route}|${r.label_key}`, { drive_min: r.drive_min, source: r.source, lat: r.lat, lng: r.lng }])),
    savePlace: (key, lat, lng, min, source, route = 'drive') =>
      client.query('select app_prj02.job_save_place($1, $2, $3, $4, $5, $6)', [key, lat, lng, min, source, route]),
    upsertTrip: (t) => one(client, 'select app_prj02.job_upsert_trip($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) as r',
      [t.event_id, t.start, t.end, t.title, t.location, t.drive_min, t.drive_source, t.drop_leave, t.pick_leave, t.drop_send, t.pick_send,
        t.drop_needed ?? true, t.pick_needed ?? true, t.child_ids ?? [], t.who_state ?? 'child', t.unknown_name ?? null]),
    cancelMissing: (from, to, keep) => one(client, 'select app_prj02.job_cancel_missing($1, $2, $3) as r', [from, to, keep]),
    markScan: (lat, lng) => client.query('select app_prj02.job_mark_scan($1, $2)', [lat, lng]),
    trips: (from, to) => rows('select * from app_prj02.trips where event_start >= $1 and event_start < $2 order by event_start', [from, to]),
    trip: async (id) => (await rows('select * from app_prj02.trips where id = $1', [id]))[0] ?? null,
    queue: (trip, kind, person, at, payload) =>
      one(client, 'select app_prj02.job_queue($1, $2, $3, $4, $5) as r', [trip, kind, person, at, JSON.stringify(payload ?? {})]),
    claimDue: (limit) => rows('select * from app_prj02.job_claim_due($1)', [limit]),
    markFailed: (id) => client.query('select app_prj02.job_mark_failed($1)', [id]),
    askedNames: async () => (await rows(`select distinct t.unknown_name as n from app_prj02.reminders r
      join app_prj02.trips t on t.id = r.trip_id where r.kind = 'unknown' and t.unknown_name is not null`)).map((r) => r.n),
    holdTrip: (trip) => one(client, 'select app_prj02.job_hold_trip($1) as r', [trip]),
  };
}

/** Runs fn(jobStore) in one transaction as the scheduler role. */
export async function inJobTransaction(fn, { url = process.env.JOB_DB_URL } = {}) {
  const client = await getPool(url, 'JOB_DB_URL').connect();
  try {
    await client.query('begin');
    const out = await fn(jobStoreFor(client));
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Runs fn(store) in one transaction; commits on success, rolls back on any error. */
export async function inTransaction(fn, { url = process.env.APP_DB_URL } = {}) {
  const client = await getPool(url).connect();
  try {
    await client.query('begin');
    const out = await fn(storeFor(client));
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
