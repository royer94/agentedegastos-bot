import { sendMessage, getFile, downloadFile } from "../netlify/functions/lib/telegram.js";
import { transcribirAudio, extraerGasto, generarResumen } from "../netlify/functions/lib/ai.js";
import {
  getOrCreateUser, descontarCredito, guardarGasto,
  obtenerResumenHoy, obtenerResumenSemanal, obtenerResumenSemanaPasada,
  obtenerResumenMes, obtenerTodosGastos,
  obtenerUltimosGastos, borrarGasto,
  guardarIngreso, obtenerIngresosMes,
  obtenerUltimosIngresos, borrarIngreso,
  obtenerMeta, guardarMeta,
  incrementarComandos, marcarGuiaVista,
} from "../netlify/functions/lib/firebase.js";

function formatCOP(m) { return "$" + Number(m).toLocaleString("es-CO") + " COP"; }
function formatCat(cat) { return cat || "Otro"; }

const CATEGORIAS = [
  "Comida", "Bebidas alcoholicas", "Cafe",
  "Transporte", "Vehiculo", "Parqueadero",
  "Salud", "Belleza", "Bienestar",
  "Hogar", "Reparaciones", "Electrodomesticos", "Decoracion",
  "Educacion", "Hijos", "Mascotas", "Adultos mayores",
  "Ahorro", "Deudas", "Seguros", "Inversiones",
  "Entretenimiento", "Viajes", "Deportes", "Suscripciones",
  "Trabajo", "Publicidad", "Tecnologia", "Proveedores",
  "Ropa", "Accesorios",
  "Regalos", "Donaciones", "Impuestos", "Multas", "Otro"
];

// ─── MENSAJES DE INVITACION PRO ───────────────────────────────────────────────

const MENSAJES_PRO = [
  "Con el Plan Pro registras gastos ilimitados, ingresos y ves tu balance real mes a mes. Solo $15.000 COP/mes. Usa /pro.",
  "Sabias que con el Plan Pro puedes registrar tus ingresos y ver cuanto te queda despues de gastos? Mira /pro.",
  "El Plan Pro incluye meta mensual con alertas, balance ingresos vs gastos, y reportes por voz. Planes desde $15.000 COP en /pro.",
  "Con el Plan Pro los reportes por voz quedan habilitados y puedes llevar el control completo de tus finanzas. Mira /pro.",
];

async function verificarMensajePro(chatId, telegramId, user) {
  if (user.plan === "pro") return;
  const count = await incrementarComandos(telegramId);
  if (count % 4 === 0) {
    const msg = MENSAJES_PRO[(count / 4 - 1) % MENSAJES_PRO.length];
    await sendMessage(chatId, "💡 " + msg);
  }
}

// ─── GUIA DE USO ──────────────────────────────────────────────────────────────

async function enviarGuia(chatId, esPro) {
  const pasos = [
    "Bienvenido a Agente de Gastos! Te explico como usarme en unos pasos rapidos. (1/5)",
    "REGISTRAR GASTOS (2/5)\n\nEscribe o manda un audio con lo que gastaste:\n- Gaste 15 mil en almuerzo\n- Pague cien lucas de taxi\n- Compre mercado por 80 mil\n\nYo categorizo automaticamente en 36 categorias.",
    "CONSULTAR REPORTES (3/5)\n\nUsa estos comandos:\n/hoy - gastos de hoy\n/semana - ultimos 7 dias\n/vsanterior - esta semana vs la anterior\n/mes - mes actual\n/top - en que gastas mas\n/compartir - resumen para compartir" +
    (esPro ? "\n/balance - ingresos vs gastos del mes" : "\n\n(Con Plan Pro: /balance para ver ingresos vs gastos)"),
    "GESTIONAR GASTOS (4/5)\n\n/gastos - ver ultimos 5 gastos\n/borrargasto - borra el ultimo gasto" +
    (esPro ? "\n\nGestion ingresos:\n/ingresos - ver ultimos 5 ingresos\n/borraringreso - borra el ultimo ingreso" : ""),
    esPro
      ? "PLAN PRO ACTIVO (5/5)\n\nTienes acceso completo:\n- Registros ilimitados\n- Registro de ingresos\n- Balance ingresos vs gastos\n- Meta mensual con alertas\n- Reportes por voz\n\nPara registrar un ingreso di o escribe naturalmente:\n- Me pagaron 2 millones de salario\n- Me llego la quincena\n- Vendi el carro por 5 palos"
      : "PLAN PRO (5/5)\n\nEl plan gratuito incluye 20 registros y todos los reportes de gastos.\n\nCon el Plan Pro ademas tendras:\n- Registros ilimitados\n- Registro de ingresos\n- Balance ingresos vs gastos\n- Meta mensual con alertas al 50%, 80% y 100%\n- Reportes por voz\n\nUsa /pro para ver planes desde $15.000 COP/mes.\n\nYa puedes empezar! Dime en que gastaste hoy.",
  ];
  for (const paso of pasos) {
    await sendMessage(chatId, paso);
    await new Promise(r => setTimeout(r, 600));
  }
}

// ─── CLASIFICAR AUDIO CON IA ──────────────────────────────────────────────────

async function clasificarAudio(texto, esPro) {
  const Groq = (await import("groq-sdk")).default;
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const ingresoInstruccion = esPro
    ? `3. Si es un INGRESO (recibio dinero): {"tipo": "ingreso", "monto": numero, "descripcion": "descripcion corta"}
   Ejemplos: me pagaron, me llego, vendi, me devolvieron, recibi, me consignaron, entre, cai, gane, cobre, me transfirieron, me dieron, quincena, salario, freelance`
    : "";

  const res = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: `El usuario dice por audio: "${texto}"

Clasifica y responde SOLO JSON:

1. Si es un GASTO: {"tipo": "gasto"}
2. Si es COMANDO de consulta: {"tipo": "comando", "comando": "/hoy"}
   Comandos: /hoy /semana /mes /vsanterior /top /compartir${esPro ? " /balance" : ""}
${ingresoInstruccion}` }],
    temperature: 0.1,
    max_tokens: 80,
  });
  try {
    return JSON.parse(res.choices[0].message.content.replace(/```json|```/g,"").trim());
  } catch {
    return { tipo: "gasto" };
  }
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────

async function handleStart(chatId, user) {
  if (user.proVencido) {
    await sendMessage(chatId, "Tu Plan Pro ha vencido. Volviste al plan gratuito.\n\nRenueva con /pro");
  }
  const diasRestantes = user.plan === "pro" && user.proExpira
    ? Math.ceil((new Date(user.proExpira) - new Date()) / (1000*60*60*24))
    : null;
  const saludo = user.isNew ? "Hola " + user.name + "!" : "Bienvenido de vuelta " + user.name + "!";
  const estado = user.plan === "pro"
    ? "Plan Pro activo - registros ilimitados. Vence en " + diasRestantes + " dias."
    : "Tienes " + user.credits + " registros gratuitos disponibles.";
  await sendMessage(chatId,
    saludo + "\n\n" + estado + "\n\n" +
    "Comandos rapidos:\n" +
    "/guia - tutorial completo\n" +
    "/ayuda - lista de comandos\n" +
    "/pro - planes y precios"
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
  const porCat = Object.entries(resumen.porCategoria).sort((a,b)=>b[1]-a[1])
    .map(([c,m]) => "- " + formatCat(c) + ": " + formatCOP(m)).join("\n");
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
  const tendencia = diff > 0 ? "Gastaste mas que la semana pasada." : diff < 0 ? "Gastaste menos. Bien!" : "Igual que la semana pasada.";
  const catEsta = esta.reduce((acc,g) => { acc[g.categoria]=(acc[g.categoria]||0)+g.monto; return acc; }, {});
  const catAnterior = anterior.reduce((acc,g) => { acc[g.categoria]=(acc[g.categoria]||0)+g.monto; return acc; }, {});
  const todasCat = [...new Set([...Object.keys(catEsta), ...Object.keys(catAnterior)])];
  const comparativo = todasCat.sort((a,b)=>(catEsta[b]||0)-(catEsta[a]||0)).slice(0,5)
    .map(c => "- " + formatCat(c) + ": " + formatCOP(catEsta[c]||0) + " vs " + formatCOP(catAnterior[c]||0)).join("\n");
  await sendMessage(chatId,
    "Esta semana vs anterior\n\n" +
    "Esta semana: " + formatCOP(totalEsta) + " (" + esta.length + " gastos)\n" +
    "Semana anterior: " + formatCOP(totalAnterior) + " (" + anterior.length + " gastos)\n" +
    "Diferencia: " + signo + formatCOP(Math.abs(diff)) + " (" + signo + pct + "%)\n\n" +
    tendencia + "\n\nPor categoria:\n" + (comparativo || "Sin datos suficientes.")
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

async function handleBalance(chatId, telegramId, user) {
  if (user.plan !== "pro") {
    return sendMessage(chatId,
      "El balance de ingresos vs gastos es exclusivo del Plan Pro.\n\n" +
      "Con el Plan Pro puedes registrar tus ingresos y ver cuanto te queda cada mes.\n\n" +
      "Activa tu plan con /pro"
    );
  }
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
    (detalleIngresos ? "\n\nDetalle ingresos:\n" + detalleIngresos : "\n\nAun no has registrado ingresos este mes.\nDi o escribe: me pagaron [monto] de [concepto]")
  );
}

async function handleTop(chatId, telegramId) {
  await sendMessage(chatId, "Analizando tus habitos de gasto...");
  const todos = await obtenerTodosGastos(telegramId);
  if (!todos.length) return sendMessage(chatId, "No tienes gastos registrados aun.");
  const porCat = todos.reduce((acc,g) => { acc[g.categoria]=(acc[g.categoria]||0)+g.monto; return acc; }, {});
  const total = todos.reduce((s,g) => s + g.monto, 0);
  const ranking = Object.entries(porCat).sort((a,b)=>b[1]-a[1])
    .map(([c,m], i) => {
      const pct = Math.round((m/total)*100);
      const filled = Math.min(Math.round(pct/5), 20);
      const bar = "█".repeat(filled) + "░".repeat(20-filled);
      return (i+1)+". "+formatCat(c)+": "+formatCOP(m)+" ("+pct+"%)\n   ["+bar+"]";
    }).join("\n");
  await sendMessage(chatId, "Tus categorias de mayor gasto\n\n" + ranking + "\n\nTotal: " + formatCOP(total) + " en " + todos.length + " transacciones");
}

async function handleGastos(chatId, telegramId) {
  const gastos = await obtenerUltimosGastos(telegramId, 5);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos registrados aun.");
  let msg = "Ultimos 5 gastos:\n\n";
  gastos.forEach((g, i) => {
    const fecha = new Date(g.fecha).toLocaleDateString("es-CO");
    msg += (i+1) + ". " + formatCat(g.categoria) + " - " + formatCOP(g.monto) + " | " + g.descripcion + " (" + fecha + ")\n";
  });
  msg += "\nPara borrar el ultimo: /borrargasto";
  await sendMessage(chatId, msg);
}

async function handleBorrarGasto(chatId, telegramId) {
  const gastos = await obtenerUltimosGastos(telegramId, 1);
  if (!gastos.length) return sendMessage(chatId, "No tienes gastos para borrar.");
  const ultimo = gastos[0];
  await borrarGasto(telegramId, ultimo.id);
  await sendMessage(chatId, "Gasto borrado:\n" + formatCat(ultimo.categoria) + " - " + formatCOP(ultimo.monto) + " | " + ultimo.descripcion);
}

async function handleIngresos(chatId, telegramId, user) {
  if (user.plan !== "pro") return sendMessage(chatId, "El registro de ingresos es exclusivo del Plan Pro.\n\nActiva tu plan con /pro");
  const ingresos = await obtenerUltimosIngresos(telegramId, 5);
  if (!ingresos.length) return sendMessage(chatId, "No tienes ingresos registrados aun.\n\nPara registrar un ingreso di o escribe:\n- Me pagaron 2 millones de salario\n- Me llego la quincena de 1.5 palos");
  let msg = "Ultimos 5 ingresos:\n\n";
  ingresos.forEach((ing, i) => {
    const fecha = new Date(ing.fecha).toLocaleDateString("es-CO");
    msg += (i+1) + ". " + formatCOP(ing.monto) + " | " + ing.descripcion + " (" + fecha + ")\n";
  });
  msg += "\nPara borrar el ultimo: /borraringreso";
  await sendMessage(chatId, msg);
}

async function handleBorrarIngreso(chatId, telegramId, user) {
  if (user.plan !== "pro") return sendMessage(chatId, "El registro de ingresos es exclusivo del Plan Pro.\n\nActiva tu plan con /pro");
  const ingresos = await obtenerUltimosIngresos(telegramId, 1);
  if (!ingresos.length) return sendMessage(chatId, "No tienes ingresos para borrar.");
  const ultimo = ingresos[0];
  await borrarIngreso(telegramId, ultimo.id);
  await sendMessage(chatId, "Ingreso borrado:\n" + formatCOP(ultimo.monto) + " | " + ultimo.descripcion);
}

async function handleCompartir(chatId, telegramId, user) {
  await sendMessage(chatId, "Generando resumen para compartir...");
  const [gastosMes, gastosSemana] = await Promise.all([
    obtenerResumenMes(telegramId),
    obtenerResumenSemanal(telegramId),
  ]);
  const totalMes = gastosMes.reduce((s,g) => s + g.monto, 0);
  const totalSemana = gastosSemana.reduce((s,g) => s + g.monto, 0);
  const porCat = gastosMes.reduce((acc,g) => { acc[g.categoria]=(acc[g.categoria]||0)+g.monto; return acc; }, {});
  const top3 = Object.entries(porCat).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,m]) => formatCat(c)+": "+formatCOP(m)).join(" | ");
  const mes = new Date().toLocaleString("es-CO", { month: "long", year: "numeric" });

  let resumen = "--- Mi resumen financiero ---\n" +
    mes.charAt(0).toUpperCase() + mes.slice(1) + "\n\n" +
    "Gastos del mes: " + formatCOP(totalMes) + "\n" +
    "Gastos esta semana: " + formatCOP(totalSemana) + "\n";

  if (user.plan === "pro") {
    const ingresos = await obtenerIngresosMes(telegramId);
    const totalIngresos = ingresos.reduce((s,i) => s + i.monto, 0);
    if (totalIngresos > 0) {
      const balance = totalIngresos - totalMes;
      resumen += "Ingresos: " + formatCOP(totalIngresos) + "\nBalance: " + formatCOP(balance) + "\n";
    }
  }

  resumen += "\nTop categorias:\n" + (top3 || "Sin datos") + "\n\nRegistrado con @Agentedegastos_bot";
  await sendMessage(chatId, resumen);
}

async function handleMeta(chatId, telegramId, user, monto) {
  if (user.plan !== "pro") return sendMessage(chatId, "Las metas con alertas son exclusivas del Plan Pro.\n\nActiva tu plan con /pro");
  if (!monto) {
    const meta = await obtenerMeta(telegramId);
    const gastosMes = await obtenerResumenMes(telegramId);
    const totalMes = gastosMes.reduce((s,g) => s + g.monto, 0);
    if (!meta) return sendMessage(chatId, "No tienes una meta configurada.\n\nEscribe:\nmeta [monto] — ej: meta 800000");
    const pct = Math.round((totalMes / meta) * 100);
    const filled = Math.min(Math.round(pct / 10), 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const estado = pct >= 100 ? "Has superado tu meta!" : pct >= 80 ? "Estas cerca del limite!" : pct >= 50 ? "Vas por la mitad." : "Vas bien!";
    return sendMessage(chatId, "Meta mensual: " + formatCOP(meta) + "\n\nGastado: " + formatCOP(totalMes) + " (" + pct + "%)\n[" + bar + "]\n\n" + estado + "\n\nPara cambiar: meta [monto]");
  }
  const montoNum = parseInt(monto.replace(/[^0-9]/g, ""));
  if (isNaN(montoNum) || montoNum <= 0) return sendMessage(chatId, "Monto invalido. Ejemplo: meta 800000");
  await guardarMeta(telegramId, montoNum);
  await sendMessage(chatId, "Meta configurada: " + formatCOP(montoNum) + " por mes.\n\nTe avisare cuando llegues al 50%, 80% y 100%.");
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
  if (user.plan === "pro") {
    const dias = user.proExpira ? Math.ceil((new Date(user.proExpira) - new Date()) / (1000*60*60*24)) : "?";
    return sendMessage(chatId, "Ya tienes Plan Pro activo!\n\nVence en " + dias + " dias.\n\nPara renovar transfiere antes del vencimiento y envia el comprobante.");
  }
  await sendMessage(chatId,
    "Plan Pro - Opciones de suscripcion\n\n" +
    "1 mes: $15.000 COP\n" +
    "3 meses: $40.500 COP (ahorra 10%)\n" +
    "6 meses: $76.500 COP (ahorra 15%) + Manual de finanzas personales\n" +
    "12 meses: $144.000 COP (ahorra 20%) + Manual de finanzas + Manual de inversiones\n\n" +
    "Que incluye el Plan Pro:\n" +
    "- Registros ilimitados (gratis = 20)\n" +
    "- Registro de ingresos\n" +
    "- Balance ingresos vs gastos del mes\n" +
    "- Meta mensual con alertas al 50%, 80% y 100%\n" +
    "- Reportes por voz\n\n" +
    "Como activarlo:\n" +
    "1. Transfiere el valor a:\n" +
    "   Nequi: 3223208126\n" +
    "   Bre-B: @roraru9\n" +
    "2. Envia comprobante con: Pro [tu nombre] [meses]\n" +
    "   Ej: Pro Carlos 3\n" +
    "3. Te activamos en menos de 1 hora"
  );
}

async function handleAyuda(chatId, user) {
  const esPro = user.plan === "pro";
  let msg =
    "Comandos disponibles:\n\n" +
    "Registros (texto o audio):\n" +
    "- Cualquier gasto: gaste 15 mil en almuerzo\n" +
    (esPro ? "- Ingresos: me pagaron, me llego, vendi, gane...\n" : "") +
    "\nReportes (texto free y Pro / voz solo Pro):\n" +
    "/hoy - gastos de hoy\n" +
    "/semana - ultimos 7 dias\n" +
    "/vsanterior - esta semana vs la anterior\n" +
    "/mes - mes actual\n" +
    "/top - ranking historico\n" +
    "/compartir - resumen para compartir\n" +
    (esPro ? "/balance - ingresos vs gastos del mes\n" : "") +
    "\nGestion gastos:\n" +
    "/gastos - ver ultimos 5 gastos\n" +
    "/borrargasto - borra el ultimo gasto\n" +
    (esPro ? "\nGestion ingresos:\n/ingresos - ver ultimos 5 ingresos\n/borraringreso - borra el ultimo ingreso\n" : "") +
    "\nPlan Pro:\n" +
    "/meta - configurar meta mensual\n" +
    "meta [monto] - ej: meta 800000\n" +
    "/pro - ver planes y precios\n\n" +
    "/guia - tutorial completo\n" +
    "/ayuda - este menu";
  await sendMessage(chatId, msg);
}

// ─── PROCESAR INGRESO (solo Pro) ──────────────────────────────────────────────

async function procesarIngreso(chatId, telegramId, monto, descripcion) {
  await guardarIngreso(telegramId, { monto, descripcion, categoria: "Ingreso" });
  await sendMessage(chatId, "Ingreso registrado\n\nIngreso: " + formatCOP(monto) + "\n" + descripcion + "\n\nUsa /balance para ver ingresos vs gastos del mes.");
}

// ─── PROCESAR GASTO ───────────────────────────────────────────────────────────

async function procesarGasto(chatId, telegramId, texto, esAudio, user) {
  const credito = await descontarCredito(telegramId);
  if (!credito.ok) return sendMessage(chatId, "Se te acabaron los registros gratuitos.\n\nActiva el Plan Pro: /pro");

  const Groq = (await import("groq-sdk")).default;
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: `Eres un asistente financiero colombiano. El usuario dice: "${texto}"

Extrae el gasto y responde SOLO JSON:
{"esGasto": true/false, "monto": numero en pesos colombianos, "descripcion": "descripcion corta", "categoria": "categoria exacta", "nota": ""}

Categorias disponibles:
${CATEGORIAS.join(", ")}

Reglas de asignacion:
- almuerzo, tinto, domicilio, mercado → Comida
- cerveza, trago, bar, licor → Bebidas alcoholicas
- cafe, cafeteria → Cafe
- taxi, bus, uber, metro, gasolina → Transporte
- SOAT, revision, aceite, llantas → Vehiculo
- parqueadero → Parqueadero
- medico, farmacia, medicamento, gym → Salud
- peluqueria, manicure, cosmeticos → Belleza
- spa, masaje → Bienestar
- arriendo, servicios, agua, luz → Hogar
- plomero, electricista, pintura → Reparaciones
- nevera, lavadora, televisor → Electrodomesticos
- mueble, cuadro, planta → Decoracion
- colegio, universidad, curso, libro → Educacion
- pañal, juguete, ropa niño → Hijos
- veterinario, comida mascota → Mascotas
- cuidado adulto mayor → Adultos mayores
- ahorro, CDT, fondo → Ahorro
- cuota credito, prestamo → Deudas
- seguro vida, seguro carro → Seguros
- acciones, crypto, inversion → Inversiones
- cine, concierto, restaurante elegante → Entretenimiento
- tiquete, hotel, tour → Viajes
- futbol, tenis, equipos deportivos → Deportes
- netflix, spotify, amazon → Suscripciones
- papeleria, herramienta → Trabajo
- pauta, marketing → Publicidad
- computador, celular, software → Tecnologia
- materia prima, inventario → Proveedores
- ropa, zapatos, vestido → Ropa
- bolso, reloj, joya → Accesorios
- regalo, flores → Regalos
- donacion, iglesia → Donaciones
- impuesto predial, renta → Impuestos
- multa, comparendo → Multas

Si no es un gasto retorna: {"esGasto": false}` }],
    temperature: 0.1,
    max_tokens: 150,
  });

  let gasto;
  try {
    gasto = JSON.parse(res.choices[0].message.content.replace(/```json|```/g,"").trim());
  } catch {
    gasto = { esGasto: false };
  }

  if (!gasto.esGasto) return sendMessage(chatId, "No entendi eso como un gasto.\n\nEjemplos:\n- Gaste 20 mil en el bus\n- Pague 50 lucas en el super");

  await guardarGasto(telegramId, { monto: gasto.monto, descripcion: gasto.descripcion, categoria: gasto.categoria, nota: gasto.nota||"", fuenteTexto: esAudio?"audio":"texto", textoOriginal: texto });
  const restantes = credito.credits === "inf" ? "ilimitados" : credito.credits;
  await sendMessage(chatId, "Gasto registrado\n\n" + formatCat(gasto.categoria) + " - " + formatCOP(gasto.monto) + "\n" + gasto.descripcion + "\n\nRegistros restantes: " + restantes);
  if (credito.credits !== "inf" && credito.credits === 3) await sendMessage(chatId, "Te quedan solo 3 registros gratuitos. Activa el Plan Pro: /pro");
  if (user.plan === "pro") await verificarAlertas(chatId, telegramId);
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
    const esPro = user.plan === "pro";

    if (user.proVencido) {
      await sendMessage(chatId, "Tu Plan Pro ha vencido. Volviste al plan gratuito.\n\nRenueva con /pro");
    }

    if (user.isNew) {
      await marcarGuiaVista(telegramId);
      await enviarGuia(chatId, esPro);
      return res.status(200).send("OK");
    }

    const text = (message.text || "").replace(/@\w+/, "").trim();
    const textLower = text.toLowerCase();

    if (text === "/start") { await handleStart(chatId, user); }
    else if (text === "/guia") { await enviarGuia(chatId, esPro); }
    else if (text === "/hoy") { await handleHoy(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/semana") { await handleSemana(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/vsanterior") { await handleVsAnterior(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/mes") { await handleMes(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/balance") { await handleBalance(chatId, telegramId, user); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/top") { await handleTop(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/gastos") { await handleGastos(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/borrargasto") { await handleBorrarGasto(chatId, telegramId); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/ingresos") { await handleIngresos(chatId, telegramId, user); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/borraringreso") { await handleBorrarIngreso(chatId, telegramId, user); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/compartir") { await handleCompartir(chatId, telegramId, user); await verificarMensajePro(chatId, telegramId, user); }
    else if (text === "/meta") { await handleMeta(chatId, telegramId, user, null); }
    else if (text === "/pro") { await handlePro(chatId, user); }
    else if (text === "/ayuda" || text === "/help") { await handleAyuda(chatId, user); }
    else if (textLower.startsWith("meta ")) { await handleMeta(chatId, telegramId, user, text.split(" ").slice(1).join(" ")); }
    else if (textLower.startsWith("pro ")) { await sendMessage(chatId, "Comprobante recibido. Te activamos en menos de 1 hora. Gracias!"); }
    else if (message.voice || message.audio) {
      await sendMessage(chatId, "Transcribiendo tu audio...");
      const fileId = message.voice?.file_id || message.audio?.file_id;
      const fileInfo = await getFile(fileId);
      const audioBuffer = await downloadFile(fileInfo.file_path);
      const transcripcion = await transcribirAudio(audioBuffer);
      if (!transcripcion || transcripcion.trim().length < 3) return res.status(200).send("OK");
      await sendMessage(chatId, "Escuche: " + transcripcion);

      const clasificacion = await clasificarAudio(transcripcion, esPro);

      if (clasificacion.tipo === "ingreso" && esPro) {
        await procesarIngreso(chatId, telegramId, clasificacion.monto, clasificacion.descripcion);
        await verificarMensajePro(chatId, telegramId, user);
      } else if (clasificacion.tipo === "ingreso" && !esPro) {
        await sendMessage(chatId, "El registro de ingresos es exclusivo del Plan Pro.\n\nActiva tu plan con /pro");
        await verificarMensajePro(chatId, telegramId, user);
      } else if (clasificacion.tipo === "comando") {
        if (!esPro) {
          await sendMessage(chatId, "Los reportes por voz son exclusivos del Plan Pro.\n\nUsa los comandos escritos:\n/hoy /semana /mes /top\n\nO activa el Plan Pro: /pro");
          await verificarMensajePro(chatId, telegramId, user);
        } else {
          const cmd = clasificacion.comando;
          if (cmd === "/hoy") await handleHoy(chatId, telegramId);
          else if (cmd === "/semana") await handleSemana(chatId, telegramId);
          else if (cmd === "/vsanterior") await handleVsAnterior(chatId, telegramId);
          else if (cmd === "/mes") await handleMes(chatId, telegramId);
          else if (cmd === "/balance") await handleBalance(chatId, telegramId, user);
          else if (cmd === "/top") await handleTop(chatId, telegramId);
          else if (cmd === "/compartir") await handleCompartir(chatId, telegramId, user);
          else await procesarGasto(chatId, telegramId, transcripcion, true, user);
        }
      } else {
        await procesarGasto(chatId, telegramId, transcripcion, true, user);
        await verificarMensajePro(chatId, telegramId, user);
      }
    }
    else if (text && text.length > 1) {
      // Para texto: si es Pro, clasificar si es ingreso o gasto
      if (esPro) {
        const clasificacion = await clasificarAudio(text, true);
        if (clasificacion.tipo === "ingreso") {
          await procesarIngreso(chatId, telegramId, clasificacion.monto, clasificacion.descripcion);
        } else {
          await procesarGasto(chatId, telegramId, text, false, user);
        }
      } else {
        await procesarGasto(chatId, telegramId, text, false, user);
      }
      await verificarMensajePro(chatId, telegramId, user);
    }

  } catch (err) {
    console.error("Error:", err.message);
    try { await sendMessage(chatId, "Ocurrio un error. Intenta de nuevo."); } catch {}
  }
  res.status(200).send("OK");
}
