// Connects the bot to this deployment (prj02-R1 US-1). Open once after the token is stored and
// production is deployed: https://<production host>/api/telegram-setup
// It takes no input and only ever points the bot at this app's own webhook, so it is safe to be
// public; calling it again changes nothing. Production only (a preview must never take the bot).
// Sets: the webhook (with the secret header), the command menu, and the profile texts with the
// privacy notice link (criterion: "the privacy policy is linked in the bot's profile").
import { telegramClient, webhookSecret } from '../lib/channel/telegram.js';
import { botConfig, productionHost } from '../lib/config.js';

export async function GET() {
  if (process.env.VERCEL_ENV !== 'production') return new Response('Not found', { status: 404 });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Response.json({ ok: false, missing: 'TELEGRAM_BOT_TOKEN' }, { status: 500 });
  const tg = telegramClient(token);
  const cfg = botConfig({ botUsername: '' });
  const url = `https://${productionHost()}/api/telegram`;
  try {
    const me = await tg.call('getMe');
    await tg.call('setWebhook', {
      url, secret_token: webhookSecret(token), allowed_updates: ['message', 'callback_query'], max_connections: 10,
    });
    await tg.call('setMyCommands', {
      commands: [
        { command: 'invite', description: 'One-time join link for another adult (admins)' },
        { command: 'pause', description: 'Stop all bot messages and AI for the family' },
        { command: 'resume', description: 'Switch the bot back on' },
        { command: 'notice', description: 'The data notice' },
        { command: 'forgetme', description: 'Leave and delete my data' },
      ],
    });
    await tg.call('setMyShortDescription', {
      short_description: `Private family assistant, invited adults only. Privacy: ${cfg.noticeUrl}`.slice(0, 120),
    });
    await tg.call('setMyDescription', {
      description: [
        'A private family assistant for our shared calendar. Only invited adults can use it.',
        `Privacy and data notice: ${cfg.noticeUrl}`,
      ].join('\n\n'),
    });
    const info = await tg.call('getWebhookInfo');
    return Response.json({
      ok: true, bot: me.username, webhook: info.url === url, pending: info.pending_update_count,
      lastError: info.last_error_message ?? null, notice: cfg.noticeUrl,
    });
  } catch (e) {
    return Response.json({ ok: false, errorType: e.type ?? e.name, status: e.status ?? null }, { status: 502 });
  }
}
