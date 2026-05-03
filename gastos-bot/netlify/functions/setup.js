// netlify/functions/setup.js
// Llama esta función UNA VEZ después de desplegar para registrar el webhook

export const handler = async (event) => {
  const secret = event.queryStringParameters?.secret;

  // Protección básica
  if (secret !== process.env.SETUP_SECRET) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const netlifyUrl = process.env.URL || process.env.DEPLOY_URL;
  const webhookUrl = `${netlifyUrl}/webhook`;

  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
    }
  );

  const data = await res.json();

  return {
    statusCode: 200,
    body: JSON.stringify({
      webhook: webhookUrl,
      resultado: data,
    }),
  };
};
