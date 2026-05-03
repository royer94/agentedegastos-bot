// netlify/functions/lib/firebase.js
// Usa Firebase REST API directamente — sin SDK, arranque instantáneo

const PROJECT_ID = "agentedegastos-a5464";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ─── AUTH: obtener token de acceso desde Service Account ─────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  // Crear JWT para Google OAuth2
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const header64 = encode(header);
  const claim64 = encode(claim);
  const sigInput = `${header64}.${claim64}`;

  // Firmar con clave privada RSA
  const privateKey = sa.private_key;
  const keyData = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const binaryKey = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const sig64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${sigInput}.${sig64}`;

  // Intercambiar JWT por access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── HELPERS REST ─────────────────────────────────────────────────────────────

async function firestoreGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${FIRESTORE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  return res.json();
}

async function firestoreSet(path, fields) {
  const token = await getAccessToken();
  const res = await fetch(`${FIRESTORE_URL}/${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

async function firestoreAdd(path, fields) {
  const token = await getAccessToken();
  const res = await fetch(`${FIRESTORE_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

async function firestoreQuery(collection, field, op, value) {
  const token = await getAccessToken();
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op,
          value: { stringValue: value },
        },
      },
      orderBy: [{ field: { fieldPath: "fecha" }, direction: "DESCENDING" }],
    },
  };

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

// ─── CONVERTIR tipos Firestore ────────────────────────────────────────────────

function toFirestore(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: String(v) };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
  }
  return fields;
}

function fromFirestore(doc) {
  if (!doc || !doc.fields) return null;
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
  }
  return obj;
}

// ─── USUARIOS ─────────────────────────────────────────────────────────────────

export async function getOrCreateUser(telegramId, name) {
  const path = `users/${telegramId}`;
  const doc = await firestoreGet(path);

  if (!doc || doc.error) {
    const newUser = {
      telegramId: String(telegramId),
      name: name || "Usuario",
      plan: "free",
      credits: 20,
      totalGastos: 0,
      createdAt: new Date().toISOString(),
    };
    await firestoreSet(path, toFirestore(newUser));
    return { ...newUser, isNew: true };
  }

  return { ...fromFirestore(doc), isNew: false };
}

export async function descontarCredito(telegramId) {
  const path = `users/${telegramId}`;
  const doc = await firestoreGet(path);
  const data = fromFirestore(doc);

  if (data.plan === "pro") return { ok: true, credits: "inf" };
  if (data.credits <= 0) return { ok: false, credits: 0 };

  const newCredits = data.credits - 1;
  await firestoreSet(path, toFirestore({ ...data, credits: newCredits }));
  return { ok: true, credits: newCredits };
}

export async function activarPro(telegramId) {
  const path = `users/${telegramId}`;
  const doc = await firestoreGet(path);
  const data = fromFirestore(doc);
  await firestoreSet(path, toFirestore({ ...data, plan: "pro" }));
}

// ─── GASTOS ───────────────────────────────────────────────────────────────────

export async function guardarGasto(telegramId, gasto) {
  const fecha = new Date().toISOString();
  const fields = toFirestore({
    telegramId: String(telegramId),
    monto: gasto.monto,
    descripcion: gasto.descripcion,
    categoria: gasto.categoria,
    nota: gasto.nota || "",
    fuenteTexto: gasto.fuenteTexto || "texto",
    fecha,
  });
  return firestoreAdd(`users/${telegramId}/gastos`, fields);
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

async function obtenerGastosDesde(telegramId, desde) {
  const token = await getAccessToken();
  const body = {
    structuredQuery: {
      from: [{ collectionId: "gastos" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "telegramId" },
                op: "EQUAL",
                value: { stringValue: String(telegramId) },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "fecha" },
                op: "GREATER_THAN_OR_EQUAL",
                value: { stringValue: desde },
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "fecha" }, direction: "DESCENDING" }],
      limit: 50,
    },
  };

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const results = await res.json();
  if (!Array.isArray(results)) return [];

  return results
    .filter((r) => r.document)
    .map((r) => fromFirestore(r.document))
    .filter(Boolean);
}
