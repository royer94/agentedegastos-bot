// netlify/functions/webhook.js
import { sendMessage, getFile, downloadFile } from "./lib/telegram.js";
import { transcribirAudio, extraerGasto, generarResumen } from "./lib/ai.js";
import {
  getOrCreateUser,
  descontarCredito,
  guardarGasto,
  obtenerResumenHoy,
  obtenerResumenSemanal,
  obtenerResumenMes,
} from "./lib/firebase.js";

function formatCOP(monto) {
  return "$" + monto.toLocaleString("es-CO") + " COP";
}

function formatCategoria(cat) {
  const map = {
    Comida: "Comida", Transporte: "Transporte", Salud: "Salud",
    Entretenimiento: "Entretenimiento", Ropa: "Ropa", Hogar: "Hogar",
    Trabajo: "Trabajo", Ahorro: "Ahorro", Otro: "Otro",
  };
  return map[cat] || cat;
}

async function handleStart(chatId, user) {
  const saludo = user.isNew
    ? "Hola " + user.name + "! Soy tu asistente de gastos personales."
    : "Bienvenido de vuelta " + user.name + "!";
  const estado = user.plan === "pro"
    ? "Plan Pro activo - registros ilimitados."
    : "Tienes " + user.credits + " registros gratuitos disponibles.";
  await sendMessage(chatId,
    saludo + "\n\n" + estado + "\n\n" +
    "Solo dime lo que gastaste en texto o audio:\n\n" +
    "Ejemplos:\n" +
    "- Gaste 15 mil en almuerzo\n" +
    "- Pague cien lucas de taxi\n" +
    "- Me gaste medio palo en el super\n\n" +
    "Comandos:\n" +
    "/hoy - resumen de hoy\n" +
    "/semana - resumen semanal\n" +
    "/mes - resumen del mes\n" +
    "/ayuda - todos los comandos\n" +
    "/pro - plan ilimitado"
  );
}

async function handleHoy(chatId, telegramId) {
  await sendMessage(chatId, "Buscando tus gastos de hoy...");
  const gastos = await obtenerResumenHoy(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No has registrado gastos hoy. Comienza diciendome en que gastaste!");
  console.log("GASTOS:", gastos.length);
  const resumen = await generarResumen(gastos, "hoy");
  console.log("RESUMEN:", JSON.stringify(resumen).substring(0, 100));
  const detalles = gastos.slice(0, 8)
    .map((g) => "- " + formatCategoria(g.categoria) + ": " + formatCOP(g.monto) + " | " + g.descripcion)
    .join("\n");
  await sendMessage(chatId, "Resumen de hoy\n\n" + resumen.texto + "\n\nDetalle:\n" + detalles);
}

async function handleSemana(chatId, telegramId) {
  await sendMessage(chatId, "Analizando tu semana...");
  const gastos = await obtenerResumenSemanal(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos registrados esta semana.");
  const resumen = await generarResumen(gastos, "esta semana");
  const porCat = Object.entries(resumen.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, monto]) => "- " + formatCategoria(cat) + ": " + formatCOP(monto))
    .join("\n");
  await sendMessage(chatId, "Resumen semanal\n\n" + resumen.texto + "\n\nPor categoria:\n" + porCat);
}

async function handleMes(chatId, telegramId) {
  await sendMessage(chatId, "Calculando tu mes...");
  const gastos = await obtenerResumenMes(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos registrados este mes.");
  const resumen = await generarResumen(gastos, "este mes");
  const top3 = Object.entries(resumen.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, monto], i) => (i + 1) + ". " + formatCategoria(cat) + ": " + formatCOP(monto))
    .join("\n");
  await sendMessage(chatId, "Resumen del mes\n\n" + resumen.texto + "\n\nTop 3 categorias:\n" + top3 + "\n\nTotal: " + resumen.cantidad + " transacciones");
}

async function handlePro(chatId, user) {
  if (user.plan === "pro") return sendMessage(chatId, "Ya tienes el Plan Pro activo! Registros ilimitados.");
  await sendMessage(chatId,
    "Plan Pro - $15.000 COP/mes\n\n" +
    "- Registros ilimitados\n" +
    "- Resumenes semanales comparativos\n" +
    "- Analisis de tendencias\n\n" +
    "Como activarlo:\n" +
    "1. Transfiere $15.000 COP a:\n" +
    "   Nequi: 3223208126\n" +
    "   Bre-B: @roraru9\n" +
    "2. Envia el comprobante con: Pro [tu nombre]\n" +
    "3. Te activamos en menos de 1 hora"
  );
}

async function handleAyuda(chatId) {
  await sendMessage(chatId,
    "Comandos disponibles:\n\n" +
    "Escribe o manda un audio con lo que gastaste.\n\n" +
    "/hoy - gastos de hoy\n" +
    "/semana - ultimos 7 dias\n" +
    "/mes - mes actual\n" +
    "/pro - plan ilimitado\n" +
    "/ayuda - este menu\n" +
    "/start - bienvenida"
  );
}

async function procesarGasto(chatId, telegramId, texto, esAudio) {
  const credito = await descontarCredito(telegramId);
  if (!credito.ok) return sendMessage(chatId, "Se te acabaron los registros gratuitos. Usa /pro para continuar.");
  const gasto = await extraerGasto(texto);
  if (!gasto.esGasto) return sendMessage(chatId, "No entendi eso como un gasto. Ejemplo: Gaste 20 mil en el bus");
  await guardarGasto(telegramId, {
    monto: gasto.monto,
    descripcion: gasto.descripcion,
    categoria: gasto.categoria,
    nota: gasto.nota || "",
    fuenteTexto: esAudio ? "audio" : "texto",
    textoOriginal: texto,
  });
  const restantes = credito.credits === "inf" ? "ilimitados" : credito.credits;
  await sendMessage(chatId,
    "Gasto registrado\n\n" +
    formatCategoria(gasto.categoria) + " - " + formatCOP(gasto.monto) + "\n" +
    gasto.descripcion + "\n\n" +
    "Registros restantes: " + restantes
  );
  if (credito.credits !== "inf" && credito.credits === 3) {
    await sendMessage(chatId, "Te quedan solo 3 registros gratuitos. Activa el Plan Pro: /pro");
  }
}

async function procesarMensaje(message) {
  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const userName = message.from.first_name || "Usuario";

  const user = await getOrCreateUser(telegramId, userName);

  const rawText = message.text || "";
  const text = rawText.replace(/@\w+/, "").trim();

  if (text === "/start") return handleStart(chatId, user);
  if (text === "/hoy")    return handleHoy(chatId, telegramId);
  if (text === "/semana") return handleSemana(chatId, telegramId);
  if (text === "/mes")    return handleMes(chatId, telegramId);
  if (text === "/pro")    return handlePro(chatId, user);
  if (text === "/ayuda" || text === "/help") return handleAyuda(chatId);

  if (text.toLowerCase().startsWith("pro ")) {
    return sendMessage(chatId, "Comprobante recibido. Activaremos el Plan Pro en menos de 1 hora. Gracias!");
  }

  if (message.voice || message.audio) {
    await sendMessage(chatId, "Transcribiendo tu audio...");
    const fileId = message.voice?.file_id || message.audio?.file_id;
    const fileInfo = await getFile(fileId);
    const audioBuffer = await downloadFile(fileInfo.file_path);
    const transcripcion = await transcribirAudio(audioBuffer);
    if (!transcripcion || transcripcion.trim().length < 3) {
      return sendMessage(chatId, "No pude entender el audio. Puedes repetirlo o escribirlo?");
    }
    await sendMessage(chatId, "Escuche: " + transcripcion);
    return procesarGasto(chatId, telegramId, transcripcion, true);
  }

  if (text && text.length > 1) {
    return procesarGasto(chatId, telegramId, text, false);
  }
}

// HANDLER PRINCIPAL — procesa completamente antes de responder
export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: "OK" };
  }

  const message = body.message;
  if (!message) return { statusCode: 200, body: "OK" };

  // Procesar completamente — Netlify Functions espera hasta que termine
  try {
    await procesarMensaje(message);
  } catch (err) {
    console.error("Error:", err.message);
    try {
      await sendMessage(message.chat.id, "Ocurrio un error. Intenta de nuevo.");
    } catch {}
  }

  return { statusCode: 200, body: "OK" };
};
