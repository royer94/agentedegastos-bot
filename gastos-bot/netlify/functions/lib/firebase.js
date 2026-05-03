// netlify/functions/lib/firebase.js
// Usa Upstash Redis REST API — simple, rapido, sin SDK pesado

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "https://distinct-parakeet-114368.upstash.io";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAAb7AAAIgcDFkZjY2M2I0NmUwYmI0YTc2YTA0NzA0ZWZkMGJiZGZlZg";

async function redis(command, ...args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(a => encodeURIComponent(a)).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

// USUARIOS

export async function getOrCreateUser(telegramId, name) {
  const key = `user:${telegramId}`;
  const existing = await redis("get", key);

  if (!existing) {
    const newUser = {
      telegramId: String(telegramId),
      name: name || "Usuario",
      plan: "free",
      credits: 20,
      createdAt: new Date().toISOString(),
    };
    await redis("set", key, JSON.stringify(newUser));
    return { ...newUser, isNew: true };
  }

  return { ...JSON.parse(existing), isNew: false };
}

export async function descontarCredito(telegramId) {
  const key = `user:${telegramId}`;
  const existing = await redis("get", key);
  const data = JSON.parse(existing);

  if (data.plan === "pro") return { ok: true, credits: "inf" };
  if (data.credits <= 0) return { ok: false, credits: 0 };

  const newCredits = data.credits - 1;
  await redis("set", key, JSON.stringify({ ...data, credits: newCredits }));
  return { ok: true, credits: newCredits };
}

export async function activarPro(telegramId) {
  const key = `user:${telegramId}`;
  const existing = await redis("get", key);
  const data = JSON.parse(existing);
  await redis("set", key, JSON.stringify({ ...data, plan: "pro" }));
}

// GASTOS

export async function guardarGasto(telegramId, gasto) {
  const fecha = new Date().toISOString();
  const id = `${telegramId}:${Date.now()}`;
  const doc = { ...gasto, telegramId: String(telegramId), fecha };

  // Guardar gasto individual
  await redis("set", `gasto:${id}`, JSON.stringify(doc));

  // Agregar a lista del usuario (max 500 gastos)
  await redis("lpush", `gastos:${telegramId}`, `gasto:${id}`);
  await redis("ltrim", `gastos:${telegramId}`, "0", "499");

  return doc;
}

async function obtenerGastosDesde(telegramId, desde) {
  const keys = await redis("lrange", `gastos:${telegramId}`, "0", "99");
  if (!keys || !Array.isArray(keys) || keys.length === 0) return [];

  const gastos = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const gasto = JSON.parse(raw);
    if (gasto.fecha >= desde) gastos.push(gasto);
  }

  return gastos;
}

export async function obtenerResumenHoy(telegramId) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return obtenerGastosDesde(telegramId, hoy.toISOString());
}

export async function obtenerResumenSemanal(telegramId) {
  const hace7 = new Date();
  hace7.setDate(hace7.getDate() - 7);
  return obtenerGastosDesde(telegramId, hace7.toISOString());
}

export async function obtenerResumenMes(telegramId) {
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  return obtenerGastosDesde(telegramId, inicioMes.toISOString());
}
