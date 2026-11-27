// Join flow and access rules of the family bot (prj02-R1 US-1).
//
// Rules (acceptance criteria of US-1 and Hub row 146):
//   1. Only registered adults use the bot. An account that has not joined is refused, whatever it
//      sends, except a valid one-time join link.
//   2. A join link shows the data notice first; the person joins only by tapping 'I agree'.
//   3. A member whose last 'I agree' is for an older notice sees the new notice and can do nothing
//      else until they agree again.
//   4. Private chats only: in a group the bot stays silent, so family data never shows there.
//
// The bot never names a person or family to the database: it passes the Telegram account, and the
// database decides who that is (decision Hub row 249). `store` runs inside one transaction per
// message (lib/db.js); tests pass a fake one.

import { handleCalendarText, handleCalendarButton } from './calendar.js';
import { handleTripButton } from './trips.js';
import { asksOutsideShare } from './guard.js';
import { LimitError } from './limits.js';
import { handlePlanText } from './plan.js';
import { parseChildrenCommand } from '../trips/who.js';

const CODE_RE = /^[0-9a-f]{32}$/;

/** Finds a join code in what a person sent: /start payload, a pasted link or the bare code. */
export function extractCode(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const fromLink = t.match(/[?&]start=([A-Za-z0-9_-]{1,64})/);
  const fromStart = t.match(/^\/start(?:@\w+)?\s+(.+)$/is);
  const raw = fromLink ? fromLink[1] : fromStart ? fromStart[1] : t;
  const compact = raw.replace(/[\s-]/g, '').toLowerCase();
  return CODE_RE.test(compact) ? compact : null;
}

/** '/Invite@FamilyBot extra' -> 'invite'; plain text -> null. */
export function command(text) {
  const m = typeof text === 'string' ? text.trim().match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s|$)/) : null;
  return m ? m[1].toLowerCase() : null;
}

export function noticeReply(cfg, { familyName, action, update = false }) {
  const intro = update
    ? 'Our data notice has changed. Please read it and agree before you go on.'
    : `You have been invited to the family bot of ${familyName}.`;
  return {
    text: [
      intro,
      '',
      'Before you join, the data notice in short:',
      '- This is a private prototype run by John for his family; replies are written by an AI (Claude).',
      '- It keeps your name as shown in Telegram, your Telegram account number and the family calendar events you ask about.',
      "- It keeps the children's names and nicknames the adults enter, only to know who each calendar event is for.",
      '- Data is kept in our database in Singapore. To understand your requests, messages go to Anthropic (the AI) and calendar changes to Google; message content is not kept in our AI logs.',
      '- Only adults of your family see your family data. Children do not use the bot.',
      '- You can leave at any time with /forgetme: your data is then deleted.',
      '',
      `Full notice: ${cfg.noticeUrl}`,
      '',
      "Tap 'I agree' to join.",
    ].join('\n'),
    buttons: [[{ label: 'I agree', action }, { label: 'No thanks', action: 'decline' }]],
  };
}

const REFUSED = {
  text: 'This is a private family bot. Only invited adults can use it. If you were invited, ask your family admin for a new join link.',
};
const CHILDREN_HELP = [
  'Your children, so I know who each calendar event is for. Your calendar names a child at the end of a title, e.g. "Ballet @ River - Cel".',
  'Add or change: /children add Celine = Cel, Ce-Ce (full name, then the nicknames and short names you use)',
  'Remove: /children remove Celine',
].join('\n');

/** /children: list, add (with aliases) or remove the family's children (US-7). Code only, no model. */
async function childrenReplies(text, store) {
  const c = parseChildrenCommand(text);
  if (c.action === 'add') {
    const r = await store.childSave(c.name, c.aliases);
    if (!r?.ok) return [{ text: r?.reason === 'too_many' ? 'At most 10 nicknames per child.' : CHILDREN_HELP }];
  } else if (c.action === 'remove') {
    const r = await store.childRemove(c.name);
    if (!r?.ok) return [{ text: `I do not have a child called "${c.name}".` }];
  } else if (c.action === 'help') {
    return [{ text: `${c.bad ? `I cannot use "${c.bad}" as a name (letters, spaces, - and ' only). ` : c.tooMany ? 'At most 10 nicknames per child. ' : ''}${CHILDREN_HELP}` }];
  }
  const kids = await store.children();
  const list = kids.length ? kids.map((k) => `- ${k.name}${k.aliases.length ? ` (also: ${k.aliases.join(', ')})` : ''}`).join('\n')
    : 'No children listed yet: until you add them, I treat every timed event as a trip.';
  return [{ text: `${c.action === 'list' ? '' : 'Done. '}Children:\n${list}\n\n${CHILDREN_HELP}` }];
}

const PAUSED = { text: 'The bot is paused for your family. Send /resume to switch it back on.' };
const OVER_BUDGET = (b) => ({
  text: `Your family's AI allowance for the last 7 days (US$${Number(b.week_max_usd).toFixed(2)}) is used up, so I cannot read requests in words for now. Commands and taps still work.`,
});

/**
 * Refusal to the asker and one warning to each other adult. The outside account is never repeated
 * and nothing goes to it: replies go only to the family's own adults (r.chat).
 */
async function outsideShareReplies(msg, ctx, store) {
  const others = (await store.adultChats()).filter((a) => String(a.chat) !== String(msg.account));
  const who = String(ctx.display_name ?? 'An adult').split(' ')[0];
  return [
    { text: `I can only share family information with the adults of this family in the bot, never with anyone else. Nothing was sent.${others.length ? ' The other adults are told.' : ''}` },
    ...others.map((a) => ({ chat: a.chat, text: `Warning: ${who} asked the family bot to share family information with an account outside the family. I refused; nothing was sent.` })),
  ];
}

const LINK_PROBLEM = {
  used: 'This join link has already been used. Ask your family admin for a new one.',
  expired: 'This join link has expired. Ask your family admin for a new one.',
  unknown: 'This join link is not valid. Ask your family admin for a new one.',
  already_member: 'This Telegram account is already in a family.',
};

function helpReply(ctx, cfg) {
  const lines = [
    `Hi ${ctx.display_name}, you are in the family bot.`,
    'Ask "what\'s on today?" or "this week?", or tell me what to add, move or cancel in the Family calendar, e.g. "Ethan swim Sat 3pm" or "move piano to Thu 5pm". I always show a change and wait for your yes.',
    'Each evening at 19:00 I ask who takes tomorrow\'s activities, and I remind the one who takes it when to leave.',
    '/children - your children and their nicknames, so I know who each event is for',
    '/pause - stop all bot messages and AI for the family; /resume - switch back on',
    '/notice - the data notice',
    '/forgetme - leave and delete your data',
  ];
  if (ctx.is_admin) lines.splice(2, 0, `/invite - a one-time join link for another adult (valid ${cfg.inviteHours} h)`);
  return { text: lines.join('\n') };
}

/**
 * Handles one message. Returns the replies to send (possibly none).
 * cfg: { noticeVersion, noticeUrl, inviteHours, botUsername, ...calendar settings }
 * deps: calendar helpers (lib/bot/calendar.js); without them, free text gets the help text.
 */
export async function handle(msg, store, cfg, deps = null) {
  if (!msg) return [];
  if (!msg.private) return []; // rule 4
  const ctx = await store.open(msg.channel, msg.account);

  if (!ctx) return handleStranger(msg, store, cfg);

  // Rule 3: an older (or missing) consent blocks everything but agreeing.
  if (ctx.notice_version !== cfg.noticeVersion) {
    if (msg.action === 'agree-update') {
      await store.recordConsent(cfg.noticeVersion);
      return [{ text: 'Thank you. You can use the bot again.' }, helpReply(ctx, cfg)];
    }
    return [noticeReply(cfg, { action: 'agree-update', update: true })];
  }

  if (msg.action === 'forget-yes') {
    await store.forgetMe();
    return [{ text: 'Done: you have left the family bot and your data is deleted. Goodbye.' }];
  }
  if (msg.action === 'forget-no') return [{ text: 'OK, nothing was deleted.' }];
  if (msg.action.startsWith('cal-') && deps) return handleCalendarButton(msg.action, ctx, store, deps);
  if (/^(tr|cl|ow|ob|hd|op|pl|ca|cn):/.test(msg.action)) return handleTripButton(msg.action, ctx, store, cfg);
  if (msg.action) return [helpReply(ctx, cfg)]; // an old button, e.g. 'I agree' tapped twice

  switch (command(msg.text)) {
    case 'invite': {
      const r = await store.createInvite(cfg.inviteHours);
      if (!r.ok) return [{ text: 'Only a family admin can invite another adult.' }];
      return [{
        text: [
          `Here is a one-time join link for ONE adult of your family, valid ${cfg.inviteHours} hours:`,
          `https://t.me/${cfg.botUsername}?start=${r.code}`,
          'Send it to them privately. Anyone with the link can join until it is used.',
        ].join('\n'),
      }];
    }
    case 'notice':
    case 'privacy':
      return [{ text: `Data notice (version ${cfg.noticeVersion}): ${cfg.noticeUrl}` }];
    case 'forgetme':
      return [{
        text: 'This deletes your place in the family bot and the data it keeps about you. It cannot be undone. Go ahead?',
        buttons: [[{ label: 'Yes, delete my data', action: 'forget-yes' }, { label: 'No', action: 'forget-no' }]],
      }];
    case 'children':
      return childrenReplies(msg.text, store);
    case 'pause':
      await store.setPause(true);
      return [{ text: 'Paused: no bot messages and no AI for your family until an adult sends /resume. Calendar taps and commands still work.' }];
    case 'resume':
      await store.setPause(false);
      return [{ text: 'Back on: reminders, questions and calendar requests work again.' }];
    case null: {
      // Plain text: a calendar request (US-2), else the help text.
      if (!deps || !msg.text.trim()) return [helpReply(ctx, cfg)];
      // AI-L08 case 1: never share with an account outside the family (no model call at all).
      if (asksOutsideShare(msg.text)) return outsideShareReplies(msg, ctx, store);
      // Limits (US-4): paused family, or its AI spend of the last 7 days at the weekly cap.
      const b = await store.budget();
      if (b?.paused) return [PAUSED];
      if (Number(b?.week_cost_usd) >= Number(b?.week_max_usd)) return [OVER_BUDGET(b)];
      try {
        // US-6: after "My own plan…", the adult's next message is their plan for that clash.
        const pending = await store.planPending();
        if (pending && deps.interpretPlan) return await handlePlanText(msg, ctx, store, deps, cfg, pending);
        const replies = await handleCalendarText(msg, ctx, store, deps, cfg);
        return replies ?? [helpReply(ctx, cfg)];
      } catch (e) {
        if (e instanceof LimitError) return [{ text: 'That request needs more work than I am allowed per request. Please ask in a shorter, simpler way.' }];
        throw e;
      }
    }
    default:
      return [helpReply(ctx, cfg)];
  }
}

async function handleStranger(msg, store, cfg) {
  // 'I agree' tapped under a notice: the button carries the code it was shown for.
  if (msg.action.startsWith('agree:')) {
    const code = extractCode(msg.action.slice(6));
    if (!code) return [REFUSED];
    const r = await store.acceptInvite(code, msg.channel, msg.account,
      (msg.name || '').slice(0, cfg.maxDisplayName ?? 80), cfg.noticeVersion);
    if (!r.ok) return [{ text: LINK_PROBLEM[r.reason] ?? REFUSED.text }];
    const ctx = await store.open(msg.channel, msg.account);
    return [{ text: `Welcome, ${ctx.display_name}. You have joined.` }, helpReply(ctx, cfg)];
  }
  if (msg.action === 'decline') return [{ text: 'OK, you have not joined and nothing was kept.' }];

  const code = extractCode(msg.text);
  if (code) {
    const p = await store.previewInvite(code);
    if (!p.ok) {
      await store.noteRefusal(msg.channel);
      return [{ text: LINK_PROBLEM[p.reason] ?? REFUSED.text }];
    }
    return [noticeReply(cfg, { familyName: p.family_name, action: `agree:${code}` })];
  }
  // Rule 1: anything else from an account that has not joined, including a typed 'I agree'
  // (which gets a hint, since only the button under the notice carries the join link).
  await store.noteRefusal(msg.channel);
  if (/^\s*i\s*agree\W*$/i.test(msg.text)) {
    return [{ text: "To join, tap the 'I agree' button under the notice, or open your join link again." }];
  }
  return [REFUSED];
}
