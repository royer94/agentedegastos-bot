// netlify/functions/lib/firebase.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

let db;

function getDb() {
  if (db) return db;

  if (!getApps().length) {
    console.log("FIREBASE ENV:", process.env.FIREBASE_SERVICE_ACCOUNT ? "presente" : "AUSENTE");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }

  db = getFirestore();
  return db;
}

// ─── USUARIOS ─────────────────────────────────────────────────────────────────

export async function getOrCreateUser(telegramId, name) {
  const db = getDb();
  const ref = db.collection("users").doc(String(telegramId));
  const snap = await ref.get();

  if (!snap.exists) {
    const newUser = {
      telegramId: String(telegramId),
      name: name || "Usuario",
      plan: "free",
      credits: 20,
      totalGastos: 0,
      createdAt: FieldValue.serverTimestamp(),
    };
    await ref.set(newUser);
    return { ...newUser, isNew: true };
  }

  return { ...snap.data(), isNew: false };
}

export async function descontarCredito(telegramId) {
  const db = getDb();
  const ref = db.collection("users").doc(String(telegramId));
  const snap = await ref.get();
  const data = snap.data();

  if (data.plan === "pro") return { ok: true, credits: "∞" };
  if (data.credits <= 0) return { ok: false, credits: 0 };

  await ref.update({ credits: FieldValue.increment(-1) });
  return { ok: true, credits: data.credits - 1 };
}

export async function activarPro(telegramId) {
  const db = getDb();
  await db.collection("users").doc(String(telegramId)).update({ plan: "pro" });
}

// ─── GASTOS ───────────────────────────────────────────────────────────────────

export async function guardarGasto(telegramId, gasto) {
  const db = getDb();
  const ref = db
    .collection("users")
    .doc(String(telegramId))
    .collection("gastos")
    .doc();

  const doc = {
    ...gasto,
    fecha: new Date().toISOString(),
    timestamp: FieldValue.serverTimestamp(),
  };

  await ref.set(doc);

  // Actualizar total acumulado del usuario
  await db
    .collection("users")
    .doc(String(telegramId))
    .update({ totalGastos: FieldValue.increment(gasto.monto) });

  return doc;
}

export async function obtenerResumenSemanal(telegramId) {
  const db = getDb();
  const hace7Dias = new Date();
  hace7Dias.setDate(hace7Dias.getDate() - 7);

  const snap = await db
    .collection("users")
    .doc(String(telegramId))
    .collection("gastos")
    .where("fecha", ">=", hace7Dias.toISOString())
    .orderBy("fecha", "desc")
    .get();

  const gastos = snap.docs.map((d) => d.data());
  return gastos;
}

export async function obtenerResumenHoy(telegramId) {
  const db = getDb();
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const snap = await db
    .collection("users")
    .doc(String(telegramId))
    .collection("gastos")
    .where("fecha", ">=", hoy.toISOString())
    .orderBy("fecha", "desc")
    .get();

  return snap.docs.map((d) => d.data());
}

export async function obtenerResumenMes(telegramId) {
  const db = getDb();
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  const snap = await db
    .collection("users")
    .doc(String(telegramId))
    .collection("gastos")
    .where("fecha", ">=", inicioMes.toISOString())
    .orderBy("fecha", "desc")
    .get();

  return snap.docs.map((d) => d.data());
}
