// Who each calendar event is for (prj02-R1 US-7, decision Hub row 298). Pure functions: the code,
// never the model, reads the family's convention and its children's names.
//
//   convention 'suffix' with separator ' - ': "[event] - [child]", e.g. "Ballet @ River - Cel"
//   several children: "UWC school day - Ang & Cel" (also ',', '+', '/', 'and')
//   extra words after a name are ignored: "UWC Violin - Ang TBC" is Ang
//   a child is found by its name or any alias (nickname, short name, full name), case ignored
//   no child part, or an adult's name -> the adult's own event, not a trip
//   a name the family has not listed -> 'unknown' (asked once)
//   no children listed yet -> 'legacy': every timed event is a trip, as before the convention
//
// Plain English: the bot reads the end of each title the way the family writes it, and looks the
// name up in the family's own list, nicknames included.

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[.!?,;:()[\]"']/g, ' ').replace(/\s+/g, ' ').trim();

/** The child part of a title under the family's convention, or null. */
export function childPart(title, conv, keys = []) {
  const t = String(title ?? '').trim();
  const sep = conv?.separator ?? ' - ';
  // 1. the separator as the family writes it (last one); 2. the same with an en or em dash;
  // 3. a bare dash, only when what follows is a known name ("Ballet-Cel", not "Ce-Ce" itself).
  const strict = t.lastIndexOf(sep);
  if (strict > 0) return t.slice(strict + sep.length).trim() || null;
  const dash = sep.trim();
  if (dash === '-') {
    const m = t.match(/^(.*\S)\s+[–—]\s+(.+)$/u);
    if (m) return m[2].trim();
    const bare = t.match(/^(.*\S)\s*[-–—]\s*([^-–—]+)$/u);
    if (bare && keys.some((k) => norm(bare[2]).startsWith(k))) return bare[2].trim();
  }
  return null;
}

/** The family's lookup keys: every name and alias, longest first. */
export function childKeys(children) {
  const keys = [];
  for (const c of children ?? []) for (const k of [c.name, ...(c.aliases ?? [])]) if (norm(k)) keys.push({ key: norm(k), id: c.id });
  return keys.sort((a, b) => b.key.length - a.key.length);
}

/**
 * { state: 'child', childIds } | { state: 'unknown', childIds, unknownName } | { state: 'none' } | { state: 'legacy' }
 */
export function parseWho(title, { convention, children, adults = [] } = {}) {
  if (!children || children.length === 0) return { state: 'legacy', childIds: [] };
  const keys = childKeys(children);
  const part = childPart(title, convention, keys.map((k) => k.key));
  if (!part) return { state: 'none', childIds: [] };
  const adultKeys = adults.map((a) => norm(String(a.display_name ?? '').split(' ')[0])).filter(Boolean);
  const names = part.split(/\s*(?:&|\+|,|\/|\band\b)\s*/iu).map((n) => n.trim()).filter(Boolean);
  const ids = []; let unknownName = null; let adultOnly = true;
  for (const n of names) {
    const nn = norm(n);
    const hit = keys.find((k) => nn === k.key || nn.startsWith(`${k.key} `));
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); adultOnly = false; continue; }
    if (adultKeys.some((a) => nn === a || nn.startsWith(`${a} `))) continue; // an adult's name
    adultOnly = false;
    unknownName ??= n.replace(/[.!?,;:()[\]"']/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 30);
  }
  if (unknownName) return { state: 'unknown', childIds: ids, unknownName };
  if (ids.length === 0 && adultOnly) return { state: 'none', childIds: [] };
  return { state: 'child', childIds: ids };
}

/** "/children add Celine = Cel, Ce-Ce" -> { name, aliases }; checks every name in code. */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,59}$/u;
export function parseChildrenCommand(text) {
  const rest = String(text ?? '').replace(/^\/children(?:@\w+)?/i, '').trim();
  if (!rest) return { action: 'list' };
  const m = rest.match(/^(add|remove|delete)\s+(.+)$/i);
  if (!m) return { action: 'help' };
  const action = m[1].toLowerCase() === 'add' ? 'add' : 'remove';
  const [rawName, rawAliases = ''] = m[2].split('=');
  const name = rawName.replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) return { action: 'help', bad: name.slice(0, 30) };
  if (action === 'remove') return { action, name };
  const aliases = rawAliases.split(/[,;/]/).map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const bad = aliases.find((a) => !NAME_RE.test(a));
  if (bad) return { action: 'help', bad: bad.slice(0, 30) };
  if (aliases.length > 10) return { action: 'help', tooMany: true };
  return { action, name, aliases };
}

