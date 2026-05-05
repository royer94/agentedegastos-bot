// netlify/functions/lib/firebase.js
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "https://distinct-parakeet-114368.upstash.io";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAAb7AAAIgcDFkZjY2M2I0NmUwYmI0YTc2YTA0NzA0ZWZkMGJiZGZlZg";

async function redis(command, ...args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(a => encodeURIComponent(a)).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

// ─── USUARIOS ─────────────────────────────────────────────────────────────────

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
  const data = JSON.parse(existing);
  if (data.plan === "pro" && data.proExpira) {
    const expira = new Date(data.proExpira);
    if (new Date() > expira) {
      const updated = { ...data, plan: "free" };
      await redis("set", key, JSON.stringify(updated));
      return { ...updated, isNew: false, proVencido: true };
    }
  }
  return { ...data, isNew: false };
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
  const expira = new Date();
  expira.setDate(expira.getDate() + 31);
  await redis("set", key, JSON.stringify({ ...data, plan: "pro", proExpira: expira.toISOString() }));
}

// ─── GASTOS ───────────────────────────────────────────────────────────────────

export async function guardarGasto(telegramId, gasto) {
  const fecha = new Date().toISOString();
  const id = `gasto:${telegramId}:${Date.now()}`;
  const doc = { ...gasto, telegramId: String(telegramId), fecha };
  await redis("set", id, JSON.stringify(doc));
  await redis("lpush", `gastos:${telegramId}`, id);
  await redis("ltrim", `gastos:${telegramId}`, "0", "499");
  return doc;
}

async function obtenerGastosDesde(telegramId, desde) {
  const keys = await redis("lrange", `gastos:${telegramId}`, "0", "99");
  if (!keys || !Array.isArray(keys) || keys.length === 0) return [];
  const items = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const item = JSON.parse(raw);
    item.id = key;
    if (item.fecha >= desde) items.push(item);
  }
  return items;
}

export async function obtenerResumenHoy(telegramId) {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  return obtenerGastosDesde(telegramId, hoy.toISOString());
}

export async function obtenerResumenSemanal(telegramId) {
  const hace7 = new Date(); hace7.setDate(hace7.getDate() - 7);
  return obtenerGastosDesde(telegramId, hace7.toISOString());
}

export async function obtenerResumenSemanaPasada(telegramId) {
  const hace14 = new Date(); hace14.setDate(hace14.getDate() - 14);
  const hace7 = new Date(); hace7.setDate(hace7.getDate() - 7);
  const keys = await redis("lrange", `gastos:${telegramId}`, "0", "199");
  if (!keys || !Array.isArray(keys)) return [];
  const items = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const item = JSON.parse(raw);
    item.id = key;
    if (item.fecha >= hace14.toISOString() && item.fecha < hace7.toISOString()) items.push(item);
  }
  return items;
}

export async function obtenerResumenMes(telegramId) {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  return obtenerGastosDesde(telegramId, inicioMes.toISOString());
}

export async function obtenerTodosGastos(telegramId) {
  const keys = await redis("lrange", `gastos:${telegramId}`, "0", "499");
  if (!keys || !Array.isArray(keys)) return [];
  const items = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const item = JSON.parse(raw);
    item.id = key;
    items.push(item);
  }
  return items;
}

export async function obtenerUltimosGastos(telegramId, limit) {
  const keys = await redis("lrange", `gastos:${telegramId}`, "0", String(limit - 1));
  if (!keys || !Array.isArray(keys) || keys.length === 0) return [];
  const gastos = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const gasto = JSON.parse(raw);
    gasto.id = key;
    gastos.push(gasto);
  }
  return gastos;
}

export async function borrarGasto(telegramId, gastoKey) {
  await redis("lrem", `gastos:${telegramId}`, "1", gastoKey);
  await redis("del", gastoKey);
}

// ─── INGRESOS (solo Pro) ──────────────────────────────────────────────────────

export async function guardarIngreso(telegramId, ingreso) {
  const fecha = new Date().toISOString();
  const id = `ingreso:${telegramId}:${Date.now()}`;
  const doc = { ...ingreso, telegramId: String(telegramId), fecha };
  await redis("set", id, JSON.stringify(doc));
  await redis("lpush", `ingresos:${telegramId}`, id);
  await redis("ltrim", `ingresos:${telegramId}`, "0", "499");
  return doc;
}

async function obtenerIngresosDesde(telegramId, desde) {
  const keys = await redis("lrange", `ingresos:${telegramId}`, "0", "99");
  if (!keys || !Array.isArray(keys) || keys.length === 0) return [];
  const items = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const item = JSON.parse(raw);
    item.id = key;
    if (item.fecha >= desde) items.push(item);
  }
  return items;
}

export async function obtenerIngresosMes(telegramId) {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  return obtenerIngresosDesde(telegramId, inicioMes.toISOString());
}

export async function obtenerUltimosIngresos(telegramId, limit) {
  const keys = await redis("lrange", `ingresos:${telegramId}`, "0", String(limit - 1));
  if (!keys || !Array.isArray(keys) || keys.length === 0) return [];
  const ingresos = [];
  for (const key of keys) {
    const raw = await redis("get", key);
    if (!raw) continue;
    const ingreso = JSON.parse(raw);
    ingreso.id = key;
    ingresos.push(ingreso);
  }
  return ingresos;
}

export async function borrarIngreso(telegramId, ingresoKey) {
  await redis("lrem", `ingresos:${telegramId}`, "1", ingresoKey);
  await redis("del", ingresoKey);
}

// ─── META ─────────────────────────────────────────────────────────────────────

export async function guardarMeta(telegramId, monto) {
  await redis("set", `meta:${telegramId}`, String(monto));
}

export async function obtenerMeta(telegramId) {
  const val = await redis("get", `meta:${telegramId}`);
  if (!val) return null;
  return parseInt(val);
}

// ─── CONTADOR Y GUIA ─────────────────────────────────────────────────────────

export async function incrementarComandos(telegramId) {
  const val = await redis("incr", `cmds:${telegramId}`);
  return parseInt(val);
}

export async function marcarGuiaVista(telegramId) {
  await redis("set", `guia:${telegramId}`, "1");
}
