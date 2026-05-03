import { sendMessage, getFile, downloadFile } from "../netlify/functions/lib/telegram.js";
import { transcribirAudio, extraerGasto, generarResumen } from "../netlify/functions/lib/ai.js";
import {
  getOrCreateUser, descontarCredito, guardarGasto, guardarIngreso,
  obtenerResumenHoy, obtenerResumenSemanal, obtenerResumenSemanaPasada,
  obtenerResumenMes, obtenerIngresosMes, obtenerTodosGastos,
  obtenerUltimosGastos, borrarGasto, borrarTodosGastos,
  obtenerMeta, guardarMeta,
} from "../netlify/functions/lib/firebase.js";

function formatCOP(m) { return "$" + Number(m).toLocaleString("es-CO") + " COP"; }
function formatCat(cat) {
  const m = { Comida:"Comida", Transporte:"Transporte", Salud:"Salud",
    Entretenimiento:"Entretenimiento", Ropa:"Ropa", Hogar:"Hogar",
    Trabajo:"Trabajo", Ahorro:"Ahorro", Ingreso:"Ingreso", Otro:"Otro" };
  return m[cat] || cat;
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────

async function handleStart(chatId, user) {
  const saludo = user.isNew ? "Hola " + user.name + "! Soy tu asistente de gastos personales." : "Bienvenido de vuelta " + user.name + "!";
  const estado = user.plan === "pro" ? "Plan Pro activo - registros ilimitados." : "Tienes " + user.credits + " registros gratuitos disponibles.";
  await sendMessage(chatId,
    saludo + "\n\n" + estado + "\n\n" +
    "Registra gastos e ingresos en texto o audio:\n\n" +
    "Gastos:\n- Gaste 15 mil en almuerzo\n- Pague cien lucas de taxi\n\n" +
    "Ingresos:\n- Ingrese 2 millones de salario\n- Entre 500 mil de freelance\n\n" +
    "Comandos:\n" +
    "/hoy - resumen de hoy\n" +
    "/semana - resumen semanal\n" +
    "/mes - resumen del mes\n" +
    "/balance - ingresos vs gastos del mes\n" +
    "/top - tus categorias con mas gasto\n" +
    "/vsanterior - esta semana vs la anterior\n" +
    "/gastos - ver y borrar gastos recientes\n" +
    "/borrar - borra el ultimo gasto\n" +
    "/resetgastos - borra todos los gastos\n" +
    "/meta - meta de gasto mensual (Pro)\n" +
    "/compartir - resumen para compartir\n" +
    "/ayuda - todos los comandos\n" +
    "/pro - plan ilimitado"
  );
}

async function handleHoy(chatId, telegramId) {
  await sendMessage(chatId, "Buscando tus gastos de hoy...");
  const gastos = await obtenerResumenHoy(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No has registrado gastos hoy. Comienza diciendome en que gastaste!");
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

async function handleVsAnterior(chatId, telegramId) {
  await sendMessage(chatId, "Comparando semanas...");
  const [esta, anterior] = await Promise.all([
    obtenerResumenSemanal(telegramId),
    obtenerResumenSemanaPasada(telegramId),
  ]);
  const totalEsta = esta.reduce((s,g) => s + g.monto, 0);
  const totalAnterior = anterior.reduce((s,g) => s + g.monto, 0);
  const diff = totalEsta - totalAnterior;
  const pct = totalAnterior > 0 ? Math.round((diff / totalAnterior) * 100) : 0;
  const signo = diff > 0 ? "+" : "";
  const tendencia = diff > 0 ? "Gastaste mas que la semana pasada." : diff < 0 ? "Gastaste menos que la semana pasada. Bien!" : "Igual que la semana pasada.";

  const catEsta = esta.reduce((acc, g) => { acc[g.categoria] = (acc[g.categoria]||0) + g.monto; return acc; }, {});
  const catAnterior = anterior.reduce((acc, g) => { acc[g.categoria] = (acc[g.categoria]||0) + g.monto; return acc; }, {});
  const todasCat = [...new Set([...Object.keys(catEsta), ...Object.keys(catAnterior)])];
  const comparativo = todasCat.sort((a,b)=>(catEsta[b]||0)-(catEsta[a]||0)).slice(0,5)
    .map(c => "- " + formatCat(c) + ": " + formatCOP(catEsta[c]||0) + " vs " + formatCOP(catAnterior[c]||0) + " semana pasada")
    .join("\n");

  await sendMessage(chatId,
    "Esta semana vs anterior\n\n" +
    "Esta semana: " + formatCOP(totalEsta) + " (" + esta.length + " gastos)\n" +
    "Semana anterior: " + formatCOP(totalAnterior) + " (" + anterior.length + " gastos)\n" +
    "Diferencia: " + signo + formatCOP(Math.abs(diff)) + " (" + signo + pct + "%)\n\n" +
    tendencia + "\n\n" +
    "Por categoria:\n" + (comparativo || "Sin datos suficientes.")
  );
}

async function handleMes(chatId, telegramId) {
  await sendMessage(chatId, "Calculando tu mes...");
  const gastos = await obtenerResumenMes(telegramId);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos este mes.");
  const resumen = await generarResumen(gastos, "este mes");
  const top3 = Object.entries(resumen.porCategoria).sort((a,b)=>b[1]-a[1]).slice(0,3)
    .map(([c,m],i) => (i+1)+". "+formatCat(c)+": "+formatCOP(m)).join("\n");
  await sendMessage(chatId, "Resumen del mes\n\n" + resumen.texto + "\n\nTop 3 categorias:\n" + top3 + "\n\nTotal: " + resumen.cantidad + " transacciones");
}

async function handleBalance(chatId, telegramId) {
  await sendMessage(chatId, "Calculando tu balance del mes...");
  const [gastos, ingresos] = await Promise.all([
    obtenerResumenMes(telegramId),
    obtenerIngresosMes(telegramId),
  ]);
  const totalGastos = gastos.reduce((s,g) => s + g.monto, 0);
  const totalIngresos = ingresos.reduce((s,i) => s + i.monto, 0);
  const balance = totalIngresos - totalGastos;
  const signo = balance >= 0 ? "+" : "";
  const estado = balance >= 0 ? "Estas en positivo este mes!" : "Tus gastos superan tus ingresos este mes.";

  const detalleIngresos = ingresos.slice(0,5).map(i => "- " + formatCOP(i.monto) + " | " + i.descripcion).join("\n");

  await sendMessage(chatId,
    "Balance de " + new Date().toLocaleString("es-CO", { month: "long" }) + "\n\n" +
    "Ingresos: " + formatCOP(totalIngresos) + " (" + ingresos.length + " registros)\n" +
    "Gastos: " + formatCOP(totalGastos) + " (" + gastos.length + " registros)\n" +
    "Balance: " + signo + formatCOP(balance) + "\n\n" +
    estado +
    (detalleIngresos ? "\n\nDetalle ingresos:\n" + detalleIngresos : "") +
    "\n\nPara registrar un ingreso escribe:\ningrese [monto] de [concepto]"
  );
}

async function handleTop(chatId, telegramId) {
  await sendMessage(chatId, "Analizando tus habitos de gasto...");
  const todos = await obtenerTodosGastos(telegramId);
  if (!todos.length) return sendMessage(chatId, "No tienes gastos registrados aun.");
  const porCat = todos.reduce((acc, g) => { acc[g.categoria] = (acc[g.categoria]||0) + g.monto; return acc; }, {});
  const total = todos.reduce((s,g) => s + g.monto, 0);
  const ranking = Object.entries(porCat).sort((a,b)=>b[1]-a[1])
    .map(([c,m], i) => {
      const pct = Math.round((m/total)*100);
      const bar = "█".repeat(Math.round(pct/5)) + "░".repeat(20-Math.round(pct/5));
      return (i+1)+". "+formatCat(c)+": "+formatCOP(m)+" ("+pct+"%)\n   ["+bar+"]";
    }).join("\n");
  await sendMessage(chatId,
    "Tus categorias de mayor gasto (historico)\n\n" + ranking +
    "\n\nTotal registrado: " + formatCOP(total) + " en " + todos.length + " transacciones"
  );
}

async function handleGastos(chatId, telegramId) {
  const gastos = await obtenerUltimosGastos(telegramId, 5);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos registrados aun.");
  let msg = "Ultimos 5 gastos:\n\n";
  gastos.forEach((g, i) => {
    const fecha = new Date(g.fecha).toLocaleDateString("es-CO");
    msg += (i+1) + ". " + formatCat(g.categoria) + " - " + formatCOP(g.monto) + " | " + g.descripcion + " (" + fecha + ")\n";
  });
  msg += "\nPara borrar uno escribe:\nborrar [numero] — ej: borrar 2";
  await sendMessage(chatId, msg);
}

async function handleBorrar(chatId, telegramId) {
  const gastos = await obtenerUltimosGastos(telegramId, 1);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos para borrar.");
  const ultimo = gastos[0];
  await borrarGasto(telegramId, ultimo.id);
  await sendMessage(chatId, "Gasto borrado:\n" + formatCat(ultimo.categoria) + " - " + formatCOP(ultimo.monto) + " | " + ultimo.descripcion);
}

async function handleBorrarNumero(chatId, telegramId, numero) {
  const gastos = await obtenerUltimosGastos(telegramId, 5);
  const idx = parseInt(numero) - 1;
  if (isNaN(idx) || idx < 0 || idx >= gastos.length) return sendMessage(chatId, "Numero invalido. Usa /gastos para ver la lista.");
  const gasto = gastos[idx];
  await borrarGasto(telegramId, gasto.id);
  await sendMessage(chatId, "Gasto borrado:\n" + formatCat(gasto.categoria) + " - " + formatCOP(gasto.monto) + " | " + gasto.descripcion);
}

async function handleResetGastos(chatId, telegramId) {
  await borrarTodosGastos(telegramId);
  await sendMessage(chatId, "Todos tus gastos han sido borrados. Empiezas desde cero.");
}

async function handleCompartir(chatId, telegramId) {
  await sendMessage(chatId, "Generando resumen para compartir...");
  const [gastosMes, ingresos, gastosSemana] = await Promise.all([
    obtenerResumenMes(telegramId),
    obtenerIngresosMes(telegramId),
    obtenerResumenSemanal(telegramId),
  ]);
  const totalMes = gastosMes.reduce((s,g) => s + g.monto, 0);
  const totalIngresos = ingresos.reduce((s,i) => s + i.monto, 0);
  const totalSemana = gastosSemana.reduce((s,g) => s + g.monto, 0);
  const balance = totalIngresos - totalMes;
  const porCat = gastosMes.reduce((acc,g) => { acc[g.categoria]=(acc[g.categoria]||0)+g.monto; return acc; }, {});
  const top3 = Object.entries(porCat).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,m])=>formatCat(c)+": "+formatCOP(m)).join(" | ");
  const mes = new Date().toLocaleString("es-CO", { month: "long", year: "numeric" });

  await sendMessage(chatId,
    "--- Mi resumen financiero ---\n" +
    mes.charAt(0).toUpperCase() + mes.slice(1) + "\n\n" +
    "Gastos del mes: " + formatCOP(totalMes) + "\n" +
    "Gastos esta semana: " + formatCOP(totalSemana) + "\n" +
    (totalIngresos > 0 ? "Ingresos: " + formatCOP(totalIngresos) + "\nBalance: " + formatCOP(balance) + "\n" : "") +
    "\nTop categorias:\n" + (top3 || "Sin datos") + "\n\n" +
    "Registrado con @Agentedegastos_bot"
  );
}

// ─── META (SOLO PRO) ──────────────────────────────────────────────────────────

async function handleMeta(chatId, telegramId, user, monto) {
  if (user.plan !== "pro") {
    return sendMessage(chatId, "Las metas con alertas son exclusivas del Plan Pro.\n\nActiva tu plan con /pro");
  }
  if (!monto) {
    const meta = await obtenerMeta(telegramId);
    const gastosMes = await obtenerResumenMes(telegramId);
    const totalMes = gastosMes.reduce((s,g) => s + g.monto, 0);
    if (!meta) return sendMessage(chatId, "No tienes una meta configurada.\n\nPara configurar escribe:\nmeta [monto] — ej: meta 800000");
    const pct = Math.round((totalMes / meta) * 100);
    const filled = Math.min(Math.round(pct / 10), 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const estado = pct >= 100 ? "Has superado tu meta!" : pct >= 80 ? "Estas cerca del limite!" : pct >= 50 ? "Vas por la mitad." : "Vas bien!";
    return sendMessage(chatId,
      "Meta mensual: " + formatCOP(meta) + "\n\n" +
      "Gastado: " + formatCOP(totalMes) + " (" + pct + "%)\n[" + bar + "]\n\n" +
      estado + "\n\nPara cambiar: meta [monto]"
    );
  }
  const montoNum = parseInt(monto.replace(/[^0-9]/g, ""));
  if (isNaN(montoNum) || montoNum <= 0) return sendMessage(chatId, "Monto invalido. Ejemplo: meta 800000");
  await guardarMeta(telegramId, montoNum);
  await sendMessage(chatId, "Meta configurada: " + formatCOP(montoNum) + " por mes.\n\nTe avisare cuando llegues al 50%, 80% y 100%.\n\nUsa /meta para ver tu progreso.");
}

async function verificarAlertas(chatId, telegramId) {
  const meta = await obtenerMeta(telegramId);
  if (!meta) return;
  const gastosMes = await obtenerResumenMes(telegramId);
  const totalMes = gastosMes.reduce((s,g) => s + g.monto, 0);
  const pct = Math.round((totalMes / meta) * 100);
  if (pct >= 100 && pct < 110) await sendMessage(chatId, "Alcanzaste el 100% de tu meta mensual!\n\nMeta: " + formatCOP(meta) + "\nGastado: " + formatCOP(totalMes));
  else if (pct >= 80 && pct < 90) await sendMessage(chatId, "Llevas el 80% de tu meta mensual.\n\nDisponible: " + formatCOP(meta - totalMes));
  else if (pct >= 50 && pct < 55) await sendMessage(chatId, "Llevas el 50% de tu meta mensual.\n\nDisponible: " + formatCOP(meta - totalMes));
}

async function handlePro(chatId, user) {
  if (user.plan === "pro") return sendMessage(chatId, "Ya tienes Plan Pro activo! Registros ilimitados.");
  await sendMessage(chatId,
    "Plan Pro - $15.000 COP/mes\n\n" +
    "- Registros ilimitados\n" +
    "- Metas de ahorro con alertas al 50%, 80% y 100%\n\n" +
    "El resto de funciones son gratis para todos!\n\n" +
    "Como activarlo:\n" +
    "1. Transfiere $15.000 a:\n" +
    "   Nequi: 3223208126\n" +
    "   Bre-B: @roraru9\n" +
    "2. Envia comprobante con: Pro [tu nombre]\n" +
    "3. Te activamos en 1 hora"
  );
}

async function handleAyuda(chatId) {
  await sendMessage(chatId,
    "Comandos disponibles:\n\n" +
    "Registros:\n" +
    "- Escribe o manda audio con tu gasto\n" +
    "- ingrese [monto] de [concepto] — registrar ingreso\n\n" +
    "Reportes:\n" +
    "/hoy - gastos de hoy\n" +
    "/semana - ultimos 7 dias\n" +
    "/vsanterior - esta semana vs la anterior\n" +
    "/mes - mes actual\n" +
    "/balance - ingresos vs gastos del mes\n" +
    "/top - tus categorias con mas gasto\n" +
    "/compartir - resumen para compartir\n\n" +
    "Gestion:\n" +
    "/gastos - ver y borrar gastos recientes\n" +
    "/borrar - borra el ultimo gasto\n" +
    "borrar [numero] - borra un gasto especifico\n" +
    "/resetgastos - borra todos los gastos\n\n" +
    "Pro:\n" +
    "/meta - configurar meta mensual con alertas\n" +
    "/pro - ver plan ilimitado"
  );
}

// ─── PROCESAR GASTO / INGRESO ─────────────────────────────────────────────────

async function procesarGasto(chatId, telegramId, texto, esAudio, user) {
  const credito = await descontarCredito(telegramId);
  if (!credito.ok) return sendMessage(chatId, "Se te acabaron los registros gratuitos.\n\nActiva el Plan Pro para registros ilimitados: /pro");
  const gasto = await extraerGasto(texto);
  if (!gasto.esGasto) return sendMessage(chatId, "No entendi eso como un gasto.\n\nEjemplo: Gaste 20 mil en el bus\n\nPara ingresos: ingrese 500 mil de salario");
  await guardarGasto(telegramId, { monto: gasto.monto, descripcion: gasto.descripcion, categoria: gasto.categoria, nota: gasto.nota||"", fuenteTexto: esAudio?"audio":"texto", textoOriginal: texto });
  const restantes = credito.credits === "inf" ? "ilimitados" : credito.credits;
  await sendMessage(chatId,
    "Gasto registrado\n\n" + formatCat(gasto.categoria) + " - " + formatCOP(gasto.monto) + "\n" + gasto.descripcion +
    "\n\nRegistros restantes: " + restantes
  );
  if (credito.credits !== "inf" && credito.credits === 3) await sendMessage(chatId, "Te quedan solo 3 registros gratuitos. Activa el Plan Pro: /pro");
  if (user.plan === "pro") await verificarAlertas(chatId, telegramId);
}

async function procesarIngreso(chatId, telegramId, texto) {
  // Extraer monto y descripcion del ingreso
  const prompt = `El usuario dice: "${texto}". Extrae el ingreso y responde SOLO JSON: {"esIngreso": true/false, "monto": numero, "descripcion": "descripcion corta"}`;
  const groq = (await import("groq-sdk")).default;
  const client = new groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1, max_tokens: 100,
  });
  let ingreso;
  try {
    ingreso = JSON.parse(res.choices[0].message.content.replace(/```json|```/g,"").trim());
  } catch { return sendMessage(chatId, "No entendi el ingreso. Ejemplo: ingrese 2 millones de salario"); }
  if (!ingreso.esIngreso || !ingreso.monto) return sendMessage(chatId, "No entendi el ingreso. Ejemplo: ingrese 500 mil de freelance");
  await guardarIngreso(telegramId, { monto: ingreso.monto, descripcion: ingreso.descripcion, categoria: "Ingreso" });
  await sendMessage(chatId, "Ingreso registrado\n\nIngreso: " + formatCOP(ingreso.monto) + "\n" + ingreso.descripcion + "\n\nUsa /balance para ver ingresos vs gastos del mes.");
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

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
    const textLower = text.toLowerCase();

    if (text === "/start") await handleStart(chatId, user);
    else if (text === "/hoy") await handleHoy(chatId, telegramId);
    else if (text === "/semana") await handleSemana(chatId, telegramId);
    else if (text === "/vsanterior") await handleVsAnterior(chatId, telegramId);
    else if (text === "/mes") await handleMes(chatId, telegramId);
    else if (text === "/balance") await handleBalance(chatId, telegramId);
    else if (text === "/top") await handleTop(chatId, telegramId);
    else if (text === "/gastos") await handleGastos(chatId, telegramId);
    else if (text === "/borrar") await handleBorrar(chatId, telegramId);
    else if (text === "/resetgastos") await handleResetGastos(chatId, telegramId);
    else if (text === "/compartir") await handleCompartir(chatId, telegramId);
    else if (text === "/meta") await handleMeta(chatId, telegramId, user, null);
    else if (text === "/pro") await handlePro(chatId, user);
    else if (text === "/ayuda" || text === "/help") await handleAyuda(chatId);
    else if (textLower.startsWith("meta ")) await handleMeta(chatId, telegramId, user, text.split(" ").slice(1).join(" "));
    else if (textLower.startsWith("borrar ")) await handleBorrarNumero(chatId, telegramId, text.split(" ")[1]);
    else if (textLower.startsWith("pro ")) await sendMessage(chatId, "Comprobante recibido. Te activamos en menos de 1 hora. Gracias!");
    else if (textLower.startsWith("ingrese ") || textLower.startsWith("entre ") || textLower.startsWith("recibi ")) await procesarIngreso(chatId, telegramId, text);
    else if (message.voice || message.audio) {
      await sendMessage(chatId, "Transcribiendo tu audio...");
      const fileId = message.voice?.file_id || message.audio?.file_id;
      const fileInfo = await getFile(fileId);
      const audioBuffer = await downloadFile(fileInfo.file_path);
      const transcripcion = await transcribirAudio(audioBuffer);
      if (!transcripcion || transcripcion.trim().length < 3) return res.status(200).send("OK");
      await sendMessage(chatId, "Escuche: " + transcripcion);
      const t = transcripcion.toLowerCase();
      if (t.startsWith("ingrese ") || t.startsWith("entre ") || t.startsWith("recibi ")) {
        await procesarIngreso(chatId, telegramId, transcripcion);
      } else {
        await procesarGasto(chatId, telegramId, transcripcion, true, user);
      }
    }
    else if (text && text.length > 1) await procesarGasto(chatId, telegramId, text, false, user);
  } catch (err) {
    console.error("Error:", err.message);
    try { await sendMessage(chatId, "Ocurrio un error. Intenta de nuevo."); } catch {}
  }
  res.status(200).send("OK");
}
