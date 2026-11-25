// Writes one core.cost_ledger row per model call, as the app's insert-only role
// (gateway_prj01 / gateway_prj02, CLAUDE.md rule 7), over a connection whose certificate is checked.
//
// Plain English: the connection is encrypted AND the gateway checks Supabase's ID card
// (its certificate) against the one Supabase root we ship here, so a fake server is refused.
// The 24/11 test connection only encrypted (Hub row 204); this file closes that gap.

import { readFileSync } from 'node:fs';
import pg from 'pg';

export const SUPABASE_ROOT_CA = readFileSync(new URL('./supabase-root-2021.crt', import.meta.url), 'utf8');

/**
 * Turns PLATFORM_DB_URL into a pg config with certificate checking forced on.
 * Any ssl settings written in the URL (sslmode, sslrootcert, ...) are ignored on purpose:
 * a URL saying sslmode=no-verify or disable must not be able to switch the check off.
 * `ca` can be replaced only by tests (a throwaway test authority).
 */
export function connectionConfig(url, { ca = SUPABASE_ROOT_CA } = {}) {
  if (!url) throw new Error('PLATFORM_DB_URL is not set');
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('PLATFORM_DB_URL must start with postgres:// or postgresql://');
  }
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    ssl: { ca, rejectUnauthorized: true, servername: u.hostname },
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    // One connection per running function: the transaction pooler shares the database side.
    max: 1,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  };
}

const LEDGER_COLUMNS = [
  'app', 'tenant_id', 'provider', 'model', 'purpose',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'cost_usd', 'latency_ms', 'agent_run_id', 'trace_id', 'ok',
];

// No RETURNING: the role may insert but not read (CLAUDE.md rule 7).
export const INSERT_SQL =
  `insert into core.cost_ledger (${LEDGER_COLUMNS.join(', ')}) values (` +
  LEDGER_COLUMNS.map((_, i) => `$${i + 1}`).join(', ') + ')';

export function ledgerValues(row) {
  return LEDGER_COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
}

let pool;
/** Default writer: a small shared pool, created on first use. */
export function makeLedgerWriter(url, opts) {
  return async function writeLedger(row) {
    if (!pool) pool = new pg.Pool(connectionConfig(url, opts));
    await pool.query(INSERT_SQL, ledgerValues(row));
  };
}
