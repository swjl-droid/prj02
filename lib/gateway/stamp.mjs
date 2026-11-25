#!/usr/bin/env node
// Version stamp of the gateway copy (decision 25/11/2026, Hub row 217).
// The source lives once in ai-platform/gateway; each app holds a stamped copy (lib/gateway).
// STAMP.json records the version, the ai-platform commit and a SHA-256 fingerprint of every file.
// Each app's CI runs:  node lib/gateway/stamp.mjs verify lib/gateway
// and fails if any file was changed, added or removed by hand.
//
// Plain English: like a sealed envelope with a list of its contents and their weights;
// if anyone opens it and swaps a page, the weights no longer match.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const STAMP_FILE = 'STAMP.json';

/** Every file under dir (sorted, forward slashes), except STAMP.json itself. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else {
      const rel = relative(base, p).split(sep).join('/');
      if (rel !== STAMP_FILE) out.push(rel);
    }
  }
  return out.sort();
}

export function fingerprints(dir) {
  const files = {};
  for (const rel of listFiles(dir)) {
    files[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
  }
  return files;
}

/** Returns a list of differences between dir and its STAMP.json (empty list = copy intact). */
export function verify(dir) {
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'));
  } catch {
    return [`${STAMP_FILE} missing or unreadable in ${dir}`];
  }
  const problems = [];
  const actual = fingerprints(dir);
  const version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  if (stamp.version !== version) problems.push(`VERSION is ${version}, stamp says ${stamp.version}`);
  for (const [f, h] of Object.entries(stamp.files ?? {})) {
    if (!(f in actual)) problems.push(`missing: ${f}`);
    else if (actual[f] !== h) problems.push(`changed: ${f}`);
  }
  for (const f of Object.keys(actual)) if (!(f in (stamp.files ?? {}))) problems.push(`added: ${f}`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'verify' || !dir) {
    console.error('Usage: node stamp.mjs verify <gateway-dir>');
    process.exit(2);
  }
  const problems = verify(dir);
  if (problems.length) {
    console.error(`Gateway copy in ${dir} differs from its stamp. Do not edit it here: change ai-platform/gateway,`);
    console.error('bump gateway/VERSION, and copy it again (scripts/gateway/sync.mjs).');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const s = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'));
  console.log(`Gateway copy intact: version ${s.version}, from ${s.source}@${s.commit.slice(0, 7)}, ${Object.keys(s.files).length} files`);
}
