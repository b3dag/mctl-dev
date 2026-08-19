import { getWebhookUrl } from './settings.js';

/**
 * A single outbound webhook for things worth knowing about without having the
 * dashboard open: a server crashing, a scheduled backup or task failing, the
 * backup volume running low. Sent as plain Discord-flavoured markdown in
 * `content`, which Discord renders directly and any other webhook receiver
 * can just treat as a text field, no embed parsing required.
 */
export async function notify(title, description) {
  const url = getWebhookUrl();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${description}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[notify] webhook returned ${res.status}`);
  } catch (e) {
    console.error('[notify] webhook failed:', e.message);
  }
}

export async function sendTestNotification() {
  if (!getWebhookUrl()) {
    const e = new Error('no webhook URL is set');
    e.status = 400;
    throw e;
  }
  await notify('mctl test notification', 'If you can see this, the webhook is working.');
}
