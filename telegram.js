// Telegram delivery — credentials come from env vars only (TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID), never hardcoded or committed. No-ops cleanly if unset.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const configured = !!(TOKEN && CHAT_ID);

export async function sendTelegram(text) {
  if (!configured) return { ok: false, reason: 'not_configured' };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || 'telegram send failed');
  return j;
}
