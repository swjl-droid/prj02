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
      if (!f || !s || !c) return null;
      return { family_id: f.id, country: f.country, settings: s, calendar_id: c.external_id, time_zone: c.time_zone,
        home: s.home_lat != null && s.home_lng != null ? { lat: s.home_lat, lng: s.home_lng } : null, adults };
    },
    places: async () => new Map((await rows('select label_key, drive_min, source from app_prj02.places'))
      .map((r) => [r.label_key, { drive_min: r.drive_min, source: r.source }])),
    savePlace: (key, lat, lng, min, source) =>
      client.query('select app_prj02.job_save_place($1, $2, $3, $4, $5)', [key, lat, lng, min, source]),
    upsertTrip: (t) => one(client, 'select app_prj02.job_upsert_trip($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r',
      [t.event_id, t.start, t.end, t.title, t.location, t.drive_min, t.drive_source, t.drop_leave, t.pick_leave, t.drop_send, t.pick_send]),
    cancelMissing: (from, to, keep) => one(client, 'select app_prj02.job_cancel_missing($1, $2, $3) as r', [from, to, keep]),
    markScan: (lat, lng) => client.query('select app_prj02.job_mark_scan($1, $2)', [lat, lng]),
    trips: (from, to) => rows('select * from app_prj02.trips where event_start >= $1 and event_start < $2 order by event_start', [from, to]),
    trip: async (id) => (await rows('select * from app_prj02.trips where id = $1', [id]))[0] ?? null,
    queue: (trip, kind, person, at, payload) =>
      one(client, 'select app_prj02.job_queue($1, $2, $3, $4, $5) as r', [trip, kind, person, at, JSON.stringify(payload ?? {})]),
    claimDue: (limit) => rows('select * from app_prj02.job_claim_due($1)', [limit]),
    markFailed: (id) => client.query('select app_prj02.job_mark_failed($1)', [id]),
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
