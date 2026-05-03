// netlify/functions/lib/telegram.js
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

export async function sendMessage(chatId, text, extra = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  };

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return res.json();
}

export async function sendMessageHTML(chatId, text) {
  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function getFile(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return data.result;
}

export async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

export async function setWebhook(url) {
  const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return res.json();
}
