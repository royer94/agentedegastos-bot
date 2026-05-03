export default async function handler(req, res) {
  const secret = req.query.secret;
  if (secret !== process.env.SETUP_SECRET) {
    return res.status(401).send("Unauthorized");
  }
  const webhookUrl = `https://agentedegastos-bot.vercel.app/api/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"], drop_pending_updates: true }),
  });
  const data = await r.json();
  res.json({ webhook: webhookUrl, resultado: data });
}
