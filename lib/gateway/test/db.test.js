// Proves the gateway checks Supabase's certificate (gap of 24/11, Hub row 204).
// A fake Postgres server answers the SSL request with certificates made here by openssl:
//   - signed by a throwaway test authority, or self-signed -> the gateway must refuse
//   - the same server, with the test authority trusted -> the handshake works (the test is not empty)
// If anyone switches the check off (rejectUnauthorized false), the refusal tests fail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';
import { connectionConfig, SUPABASE_ROOT_CA, INSERT_SQL, ledgerValues } from '../db.js';

const URL_ = 'postgresql://gateway_prj01.ref:pw%40x@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

test('bundled root is Supabase Root 2021 CA (fingerprint pinned)', () => {
  const cert = new X509Certificate(SUPABASE_ROOT_CA);
  assert.match(cert.subject, /CN=Supabase Root 2021 CA/);
  assert.equal(cert.fingerprint256,
    '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  assert.ok(new Date(cert.validTo) > new Date(), 'root certificate still valid');
});

test('config: certificate check forced on, URL ssl settings cannot switch it off', () => {
  for (const q of ['', '?sslmode=disable', '?sslmode=no-verify', '?sslmode=require&sslrootcert=/dev/null']) {
    const c = connectionConfig(URL_ + q);
    assert.equal(c.ssl.rejectUnauthorized, true, q);
    assert.equal(c.ssl.ca, SUPABASE_ROOT_CA, q);
    assert.equal(c.ssl.servername, 'aws-1-ap-southeast-1.pooler.supabase.com');
    assert.equal(c.connectionString, undefined, 'no connectionString: pg would let the URL override ssl');
  }
  const c = connectionConfig(URL_);
  assert.equal(c.user, 'gateway_prj01.ref');
  assert.equal(c.password, 'pw@x');
  assert.equal(c.port, 6543);
  assert.throws(() => connectionConfig(''), /not set/);
  assert.throws(() => connectionConfig('mysql://x@y/z'), /postgres/);
});

test('insert never asks to read back (no RETURNING) and keeps column order', () => {
  assert.ok(!/returning/i.test(INSERT_SQL));
  assert.match(INSERT_SQL, /^insert into core\.cost_ledger \(app, tenant_id, /);
  assert.equal(ledgerValues({ app: 'prj01' }).length, 14);
});

// ---- live TLS handshake against a fake Postgres server ----
let dir, server, port, handshakes = 0;
const pem = (f) => readFileSync(join(dir, f), 'utf8');
const ssl = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

function startServer(key, cert) {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      sock.once('data', (buf) => {
        // SSLRequest: length 8, code 80877103
        if (buf.length === 8 && buf.readInt32BE(4) === 80877103) {
          sock.write('S');
          const t = new tls.TLSSocket(sock, { isServer: true, key, cert });
          t.on('secure', () => { handshakes++; t.end(); });
          t.on('error', () => sock.destroy());
        } else sock.destroy();
      });
      sock.on('error', () => {});
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function tryConnect(ca) {
  const cfg = connectionConfig(`postgresql://u:p@localhost:${port}/postgres`, ca ? { ca } : undefined);
  const client = new pg.Client({ ...cfg, host: '127.0.0.1' });
  try { await client.connect(); return null; } catch (e) { return e; } finally { client.end().catch(() => {}); }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gw-tls-'));
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Test CA', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'srv.key', '-out', 'srv.csr']);
  // Signed by the test authority, with the name localhost: the only reason to refuse is who signed it.
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\n');
  ssl(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2',
    '-out', 'srv.crt', '-extfile', 'ext.cnf']);
  server = await startServer(pem('srv.key'), pem('srv.crt'));
  port = server.address().port;
});
after(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('refuses a server whose certificate is not signed by Supabase root', async () => {
  const before_ = handshakes;
  const err = await tryConnect();
  assert.ok(err, 'connection must fail');
  assert.match(err.code ?? err.message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|unable to verify|certificate/i);
  assert.equal(handshakes, before_, 'no TLS session was completed');
});

test('control: the same server is accepted when its own authority is trusted', async () => {
  const before_ = handshakes;
  const err = await tryConnect(pem('ca.crt'));
  // The fake server closes right after the handshake, so pg reports a closed connection,
  // not a certificate error: that proves the refusal above was about the certificate.
  assert.ok(!/certificate|verify|SELF_SIGNED/i.test(String(err?.code ?? err?.message ?? '')), String(err));
  assert.equal(handshakes, before_ + 1);
});

test('refuses a correctly signed certificate for another host name', async () => {
  const cfg = connectionConfig(`postgresql://u:p@other.example:${port}/postgres`, { ca: pem('ca.crt') });
  const client = new pg.Client({ ...cfg, host: '127.0.0.1' });
  const err = await client.connect().then(() => null, (e) => e);
  client.end().catch(() => {});
  assert.ok(err);
  assert.match(err.code ?? err.message, /ERR_TLS_CERT_ALTNAME_INVALID|altnames|Hostname/i);
});

