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
const LINK_PROBLEM = {
  used: 'This join link has already been used. Ask your family admin for a new one.',
  expired: 'This join link has expired. Ask your family admin for a new one.',
  unknown: 'This join link is not valid. Ask your family admin for a new one.',
  already_member: 'This Telegram account is already in a family.',
};

function helpReply(ctx, cfg) {
  const lines = [
    `Hi ${ctx.display_name}, you are in the family bot.`,
    'Tell me what to add, move or cancel in the Family calendar, e.g. "Ethan swim Sat 3pm" or "move piano to Thu 5pm". I always show the change and wait for your yes.',
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
    case null: {
      // Plain text: a calendar request (US-2), else the help text.
      if (!deps || !msg.text.trim()) return [helpReply(ctx, cfg)];
      const replies = await handleCalendarText(msg, ctx, store, deps, cfg);
      return replies ?? [helpReply(ctx, cfg)];
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
