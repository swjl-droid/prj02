// Masking for TRACE_CONTENT=masked (decision 23/11/2026, Hub row 193).
// Replaces emails, phone numbers, Singapore NRIC / FIN numbers and the given names the app passes in.
// Plain English: like blacking out a photocopy before it leaves the office. It catches patterns
// (an email always has an @), but it cannot recognise a name it was not told about, which is why
// prj02 (children) sends no content at all.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// NRIC / FIN: S, T, F, G or M, 7 digits, a letter.
const NRIC = /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g;
// Phones: any number written with a + country code, and Singapore numbers
// (8 digits starting 3, 6, 8 or 9, optionally split 4-4) with or without +65.
// Dates such as 2026-11-25 are left alone.
const PHONE = /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){5,13}\b|\b[3689]\d{3}[\s-]?\d{4}\b/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Masks one string. names: given names to hide (e.g. the user's own and their contacts'). */
export function maskText(text, names = []) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text.replace(EMAIL, '[EMAIL]').replace(NRIC, '[NRIC]').replace(PHONE, '[PHONE]');
  const list = [...new Set(names.filter((n) => typeof n === 'string' && n.trim().length >= 2))]
    .sort((a, b) => b.length - a.length); // longest first, so "Mary Ann" wins over "Mary"
  for (const name of list) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name.trim())}(?![\\p{L}\\p{N}])`, 'giu'), '[NAME]');
  }
  return out;
}

/** Masks every string inside messages, system prompts or answers (any nesting of arrays / objects). */
export function maskDeep(value, names = []) {
  if (typeof value === 'string') return maskText(value, names);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, names));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Images or files are never sent to traces in masked mode.
      if (k === 'source' && v && typeof v === 'object' && v.data) { out[k] = '[BINARY]'; continue; }
      out[k] = maskDeep(v, names);
    }
    return out;
  }
  return value;
}
