// Red-team guards (prj02-R1 US-4, John's AI-L08 attack cases), checked in code before anything
// else happens. Patterns are settings (config/settings.json), not code.
//   1. A message asking to share family information with an account outside the family: refused
//      without calling the model; the outside id is never repeated; the other adults are warned.
//   2. A calendar event whose notes or place read like an instruction to the bot: the
//      scheduler never acts on event text anyway (it sends none of it to the model); such an event
//      is also left out of the plan until an adult taps "Include it". Titles are not checked:
//      ordinary titles ("Invite the family for a BBQ") would be held for nothing, and a title is
//      only ever shown back to the family's own adults.
import { settings } from '../config.js';

const compile = (list) => (list ?? []).map((p) => new RegExp(p, 'iu'));
const SHARE = compile(settings.outside_share_patterns);
const INSTRUCTION = compile(settings.instruction_patterns);

/** Event text as plain text: Google descriptions can hold HTML. */
export function plainText(s) {
  return String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

export const asksOutsideShare = (text, patterns = SHARE) => patterns.some((r) => r.test(plainText(text)));

export const looksLikeInstruction = (ev, patterns = INSTRUCTION) =>
  [ev?.description, ev?.location].some((f) => f && patterns.some((r) => r.test(plainText(f))));
