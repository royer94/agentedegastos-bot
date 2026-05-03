import { sendMessage, getFile, downloadFile } from "../netlify/functions/lib/telegram.js";
import { transcribirAudio, extraerGasto, generarResumen } from "../netlify/functions/lib/ai.js";
import {
  getOrCreateUser, descontarCredito, guardarGasto,
  obtenerResumenHoy, obtenerResumenSemanal, obtenerResumenMes,
} from "../netlify/functions/lib/firebase.js";

function formatCOP(m) { return "$" + m.toLocaleString("es-CO") + " COP"; }
function formatCat(cat) {
  const m = { Comida:"Comida", Transporte:"Transporte", Salud:"Salud", Entretenimiento:"Entretenimiento", Ropa:"Ropa", Hogar:"Hogar", Trabajo:"Trabajo", Ahorro:"Ahorro", Otro:"Otro" };
  return m[cat] || cat;
}

async function handleStart(chatId, user) {
  const saludo = user.isNew ? "Hola " + user.name + "! Soy tu asistente de gastos personales." : "Bienvenido de vuelta " + user.name + "!";
  const estado = user.plan === "pro" ? "Plan Pro activo - registros ilimitados." : "Tienes " + user.credits + " registros gratuitos disponibles.";
  await sendMessage(chatId, saludo + "\n\n" + estado + "\n\nSolo dime lo que gastaste en texto o audio:\n\nEjemplos:\n- Gaste 15 mil en almuerzo\n- Pague cien lucas de taxi\n\nComandos:\n/hoy - resumen de hoy\n/semana - resumen semanal\n/mes - resumen del mes\n/ayuda - todos los comandos\n/pro - plan ilimitado");
}

async function handleHoy(chatId, telegramId) {
  await sendMessage(chatId, "Buscando tus gastos de hoy...");
  const gastos = await obtenerResumenHoy(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No has registrado gastos hoy!");
  const resumen = await generarResumen(gastos, "hoy");
  const detalles = gastos.slice(0,8).map(g => "- " + formatCat(g.categoria) + ": " + formatCOP(g.monto) + " | " + g.descripcion).join("\n");
  await sendMessage(chatId, "Resumen de hoy\n\n" + resumen.texto + "\n\nDetalle:\n" + detalles);
}

async function handleSemana(chatId, telegramId) {
  await sendMessage(chatId, "Analizando tu semana...");
  const gastos = await obtenerResumenSemanal(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos esta semana.");
  const resumen = await generarResumen(gastos, "esta semana");
  const porCat = Object.entries(resumen.porCategoria).sort((a,b)=>b[1]-a[1]).map(([c,m])=>"- "+formatCat(c)+": "+formatCOP(m)).join("\n");
  await sendMessage(chatId, "Resumen semanal\n\n" + resumen.texto + "\n\nPor categoria:\n" + porCat);
}

async function handleMes(chatId, telegramId) {
  await sendMessage(chatId, "Calculando tu mes...");
  const gastos = await obtenerResumenMes(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos este mes.");
  const resumen = await generarResumen(gastos, "este mes");
  const top3 = Object.entries(resumen.porCategoria).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,m],i)=>(i+1)+". "+formatCat(c)+": "+formatCOP(m)).join("\n");
  await sendMessage(chatId, "Resumen del mes\n\n" + resumen.texto + "\n\nTop 3:\n" + top3);
}

async function handlePro(chatId, user) {
  if (user.plan === "pro") return sendMessage(chatId, "Ya tienes Plan Pro activo!");
  await sendMessage(chatId, "Plan Pro - $15.000 COP/mes\n\n- Registros ilimitados\n- Resumenes comparativos\n\nComo activarlo:\n1. Transfiere $15.000 a:\n   Nequi: 3223208126\n   Bre-B: @roraru9\n2. Envia comprobante con: Pro [tu nombre]\n3. Te activamos en 1 hora");
}

async function handleAyuda(chatId) {
  await sendMessage(chatId, "Comandos:\n/hoy - gastos de hoy\n/semana - ultimos 7 dias\n/mes - mes actual\n/pro - plan ilimitado\n/ayuda - este menu");
}

async function procesarGasto(chatId, telegramId, texto, esAudio) {
  const credito = await descontarCredito(telegramId);
  if (!credito.ok) return sendMessage(chatId, "Se te acabaron los registros gratuitos. Usa /pro para continuar.");
  const gasto = await extraerGasto(texto);
  if (!gasto.esGasto) return sendMessage(chatId, "No entendi eso como un gasto. Ejemplo: Gaste 20 mil en el bus");
  await guardarGasto(telegramId, { monto: gasto.monto, descripcion: gasto.descripcion, categoria: gasto.categoria, nota: gasto.nota||"", fuenteTexto: esAudio?"audio":"texto", textoOriginal: texto });
  const restantes = credito.credits === "inf" ? "ilimitados" : credito.credits;
  await sendMessage(chatId, "Gasto registrado\n\n" + formatCat(gasto.categoria) + " - " + formatCOP(gasto.monto) + "\n" + gasto.descripcion + "\n\nRegistros restantes: " + restantes);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");
  const message = req.body?.message;
  if (!message) return res.status(200).send("OK");

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const userName = message.from.first_name || "Usuario";

  try {
    const user = await getOrCreateUser(telegramId, userName);
    const text = (message.text || "").replace(/@\w+/, "").trim();

    if (text === "/start") await handleStart(chatId, user);
    else if (text === "/hoy") await handleHoy(chatId, telegramId);
    else if (text === "/semana") await handleSemana(chatId, telegramId);
    else if (text === "/mes") await handleMes(chatId, telegramId);
    else if (text === "/pro") await handlePro(chatId, user);
    else if (text === "/ayuda" || text === "/help") await handleAyuda(chatId);
    else if (text.toLowerCase().startsWith("pro ")) await sendMessage(chatId, "Comprobante recibido. Te activamos en 1 hora!");
    else if (message.voice || message.audio) {
      await sendMessage(chatId, "Transcribiendo tu audio...");
      const fileId = message.voice?.file_id || message.audio?.file_id;
      const fileInfo = await getFile(fileId);
      const audioBuffer = await downloadFile(fileInfo.file_path);
      const transcripcion = await transcribirAudio(audioBuffer);
      if (!transcripcion || transcripcion.trim().length < 3) return res.status(200).send("OK");
      await sendMessage(chatId, "Escuche: " + transcripcion);
      await procesarGasto(chatId, telegramId, transcripcion, true);
    }
    else if (text && text.length > 1) await procesarGasto(chatId, telegramId, text, false);
  } catch (err) {
    console.error("Error:", err.message);
    try { await sendMessage(chatId, "Ocurrio un error. Intenta de nuevo."); } catch {}
  }

  res.status(200).send("OK");
}
