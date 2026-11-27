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

let pool;
function getPool(url) {
  if (!url) throw new Error('APP_DB_URL is not set');
  if (!pool) pool = new pg.Pool(connectionConfig(url));
  return pool;
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
  };
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
