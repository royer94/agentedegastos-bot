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
  const emojis = {
    Comida: "Comida",
    Transporte: "Transporte",
    Salud: "Salud",
    Entretenimiento: "Entretenimiento",
    Ropa: "Ropa",
    Hogar: "Hogar",
    Trabajo: "Trabajo",
    Ahorro: "Ahorro",
    Otro: "Otro",
  };
  return emojis[cat] || cat;
}

// FIX BUG 1: /start siempre muestra menu completo, solo cambia saludo segun si es nuevo
async function handleStart(chatId, user) {
  const saludo = user.isNew
    ? "Hola " + user.name + "! Soy tu asistente de gastos personales."
    : "Bienvenido de vuelta " + user.name + "!";

  const estado = user.plan === "pro"
    ? "Plan Pro activo - registros ilimitados."
    : "Tienes *" + user.credits + " registros gratuitos* disponibles.";

  const msg =
    saludo + "\n\n" +
    estado + "\n\n" +
    "Solo dime lo que gastaste en texto o con un audio de voz:\n\n" +
    "*Ejemplos:*\n" +
    "- Gaste 15 mil en almuerzo\n" +
    "- Pague cien lucas de taxi\n" +
    "- Me gaste medio palo en el super\n\n" +
    "*Comandos:*\n" +
    "/hoy - resumen de hoy\n" +
    "/semana - resumen semanal\n" +
    "/mes - resumen del mes\n" +
    "/ayuda - todos los comandos\n" +
    "/pro - plan ilimitado";

  await sendMessage(chatId, msg);
}

async function handleHoy(chatId, telegramId) {
  await sendMessage(chatId, "Buscando tus gastos de hoy...");
  const gastos = await obtenerResumenHoy(telegramId);

  if (!gastos.length) {
    return sendMessage(chatId, "No has registrado gastos hoy. Comienza diciendome en que gastaste!");
  }

  const resumen = await generarResumen(gastos, "hoy");
  const detalles = gastos
    .slice(0, 8)
    .map((g) => "- " + formatCategoria(g.categoria) + ": " + formatCOP(g.monto) + " | " + g.descripcion)
    .join("\n");

  await sendMessage(chatId, "*Resumen de hoy*\n\n" + resumen.texto + "\n\n*Detalle:*\n" + detalles);
}

async function handleSemana(chatId, telegramId) {
  await sendMessage(chatId, "Analizando tu semana...");
  const gastos = await obtenerResumenSemanal(telegramId);

  if (!gastos.length) {
    return sendMessage(chatId, "No tienes gastos registrados esta semana.");
  }

  const resumen = await generarResumen(gastos, "esta semana");
  const porCat = Object.entries(resumen.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, monto]) => "- " + formatCategoria(cat) + ": " + formatCOP(monto))
    .join("\n");

  await sendMessage(chatId, "*Resumen semanal*\n\n" + resumen.texto + "\n\n*Por categoria:*\n" + porCat);
}

async function handleMes(chatId, telegramId) {
  await sendMessage(chatId, "Calculando tu mes...");
  const gastos = await obtenerResumenMes(telegramId);

  if (!gastos.length) {
    return sendMessage(chatId, "No tienes gastos registrados este mes.");
  }

  const resumen = await generarResumen(gastos, "este mes");
  const top3 = Object.entries(resumen.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, monto], i) => (i + 1) + ". " + formatCategoria(cat) + ": " + formatCOP(monto))
    .join("\n");

  await sendMessage(
    chatId,
    "*Resumen del mes*\n\n" + resumen.texto + "\n\n*Top 3 categorias:*\n" + top3 + "\n\n_Total: " + resumen.cantidad + " transacciones_"
  );
}

async function handlePro(chatId, user) {
  if (user.plan === "pro") {
    return sendMessage(chatId, "Ya tienes el Plan Pro activo! Registros ilimitados.");
  }
  await sendMessage(
    chatId,
    "*Plan Pro - $15.000 COP/mes*\n\n" +
    "- Registros ilimitados\n" +
    "- Resumenes semanales comparativos\n" +
    "- Analisis de tendencias\n" +
    "- Exportar resumen mensual\n\n" +
    "*Como activarlo:*\n" +
    "1. Transfiere $15.000 COP a:\n" +
    "   Nequi: *3223208126*\n" +
    "   Bre-B: *@roraru9*\n" +
    "2. Envia el comprobante con: Pro [tu nombre]\n" +
    "3. Te activamos en menos de 1 hora"
  );
}

async function handleAyuda(chatId) {
  await sendMessage(
    chatId,
    "*Comandos disponibles:*\n\n" +
    "Escribe o manda un audio con lo que gastaste para registrarlo.\n\n" +
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
  if (!credito.ok) {
    return sendMessage(
      chatId,
      "*Se te acabaron los registros gratuitos*\n\nUsa /pro para continuar sin limites."
    );
  }

  const gasto = await extraerGasto(texto);

  if (!gasto.esGasto) {
    // devolver el credito si no era un gasto — evitar consumo innecesario
    return sendMessage(
      chatId,
      "No entendi eso como un gasto. Ejemplos:\n- Gaste 20 mil en el bus\n- Pague 50 lucas en el super\n\nUsa /ayuda para ver los comandos."
    );
  }

  await guardarGasto(telegramId, {
    monto: gasto.monto,
    descripcion: gasto.descripcion,
    categoria: gasto.categoria,
    nota: gasto.nota || "",
    fuenteTexto: esAudio ? "audio" : "texto",
    textoOriginal: texto,
  });

  const restantes = credito.credits === "inf" ? "ilimitados" : credito.credits;
  await sendMessage(
    chatId,
    "*Gasto registrado*\n\n" +
    formatCategoria(gasto.categoria) + " - *" + formatCOP(gasto.monto) + "*\n" +
    gasto.descripcion + "\n\n" +
    "_Registros restantes: " + restantes + "_"
  );

  if (credito.credits !== "inf" && credito.credits === 3) {
    await sendMessage(chatId, "Te quedan solo 3 registros gratuitos. Activa el Plan Pro: /pro");
  }
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Bad request" };
  }

  const message = body.message;
  if (!message) return { statusCode: 200, body: "No message" };

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const userName = message.from.first_name || "Usuario";

  try {
    const user = await getOrCreateUser(telegramId, userName);

    // FIX BUG 2: normalizar comando quitando @username si viene de grupo
    // Ej: "/hoy@Agentedegastos_bot" -> "/hoy"
    const rawText = message.text || "";
    const text = rawText.replace(/@\w+/, "").trim();

    // Coincidencia exacta para evitar que "/hoyyy" active /hoy
    if (text === "/start") return await handleStart(chatId, user);
    if (text === "/hoy")    return await handleHoy(chatId, telegramId);
    if (text === "/semana") return await handleSemana(chatId, telegramId);
    if (text === "/mes")    return await handleMes(chatId, telegramId);
    if (text === "/pro")    return await handlePro(chatId, user);
    if (text === "/ayuda" || text === "/help") return await handleAyuda(chatId);

    // Comprobante de pago Pro
    if (text.toLowerCase().startsWith("pro ")) {
      return await sendMessage(
        chatId,
        "*Comprobante recibido*\n\nRevisaremos tu pago y activaremos el Plan Pro en menos de 1 hora. Gracias!"
      );
    }

    // Audio de voz
    if (message.voice || message.audio) {
      await sendMessage(chatId, "Transcribiendo tu audio...");
      const fileId = message.voice?.file_id || message.audio?.file_id;
      const fileInfo = await getFile(fileId);
      const audioBuffer = await downloadFile(fileInfo.file_path);
      const transcripcion = await transcribirAudio(audioBuffer);

      if (!transcripcion || transcripcion.trim().length < 3) {
        return await sendMessage(chatId, "No pude entender el audio. Puedes repetirlo o escribirlo?");
      }

      await sendMessage(chatId, "Escuche: " + transcripcion);
      await procesarGasto(chatId, telegramId, transcripcion, true);
    }
    // Texto normal
    else if (text && text.length > 1) {
      await procesarGasto(chatId, telegramId, text, false);
    }

  } catch (error) {
    console.error("Error en webhook:", error);
    await sendMessage(chatId, "Ocurrio un error. Intenta de nuevo en un momento.");
  }

  return { statusCode: 200, body: "OK" };
};
