// netlify/functions/lib/ai.js
import Groq from "groq-sdk";
import FormData from "form-data";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── TRANSCRIPCIÓN DE AUDIO ───────────────────────────────────────────────────

export async function transcribirAudio(audioBuffer, mimeType = "audio/ogg") {
  // Groq Whisper acepta el buffer directamente como File-like object
  const file = new File([audioBuffer], "audio.ogg", { type: mimeType });

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "es",
    response_format: "text",
  });

  return transcription;
}

// ─── EXTRAER GASTO DE TEXTO ───────────────────────────────────────────────────

export async function extraerGasto(texto) {
  const prompt = `Eres un asistente financiero colombiano. El usuario dice: "${texto}"

Extrae la información del gasto y responde SOLO con un JSON válido, sin texto adicional:

{
  "esGasto": true/false,
  "monto": número en pesos colombianos (sin puntos ni comas),
  "descripcion": "descripción corta del gasto",
  "categoria": "una de: Comida, Transporte, Salud, Entretenimiento, Ropa, Hogar, Trabajo, Ahorro, Otro",
  "nota": "alguna nota adicional si la hay"
}

Ejemplos:
- "gasté quince mil en el almuerzo" → monto: 15000, categoria: Comida
- "pagué cien lucas de taxi" → monto: 100000, categoria: Transporte
- "me gasté medio palo en el gym" → monto: 500000, categoria: Salud
- "cincuenta mil pesos en mercado" → monto: 50000, categoria: Hogar

Si el mensaje NO es un gasto, retorna: {"esGasto": false}`;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: 200,
  });

  try {
    const raw = res.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { esGasto: false };
  }
}

// ─── GENERAR RESUMEN INTELIGENTE ──────────────────────────────────────────────

export async function generarResumen(gastos, periodo = "hoy") {
  if (!gastos.length) return null;

  const total = gastos.reduce((s, g) => s + g.monto, 0);
  const porCategoria = gastos.reduce((acc, g) => {
    acc[g.categoria] = (acc[g.categoria] || 0) + g.monto;
    return acc;
  }, {});

  const resumenData = {
    periodo,
    total,
    cantidadTransacciones: gastos.length,
    porCategoria,
    gastos: gastos.slice(0, 10), // máximo 10 para el contexto
  };

  const prompt = `Eres un asistente financiero amigable que habla español colombiano informal.
  
Datos de gastos del usuario (${periodo}):
${JSON.stringify(resumenData, null, 2)}

Genera un resumen breve y útil (máximo 150 palabras) con:
1. Total gastado de forma clara
2. Categoría donde más gastó
3. Un insight útil o consejo corto
4. Tono: amigable, directo, sin juzgar

Usa emojis apropiados. Formatea en texto plano para Telegram.`;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 300,
  });

  return {
    texto: res.choices[0].message.content.trim(),
    total,
    porCategoria,
    cantidad: gastos.length,
  };
}

// ─── ANÁLISIS SEMANAL COMPARATIVO ────────────────────────────────────────────

export async function generarAnalisisSemanal(gastosEstaSemana, gastosSemanaAnterior) {
  const totalEsta = gastosEstaSemana.reduce((s, g) => s + g.monto, 0);
  const totalAnterior = gastosSemanaAnterior.reduce((s, g) => s + g.monto, 0);
  const diferencia = totalEsta - totalAnterior;
  const porcentaje = totalAnterior > 0
    ? Math.round((diferencia / totalAnterior) * 100)
    : 0;

  const prompt = `Eres un asistente financiero colombiano amigable.

Esta semana: $${totalEsta.toLocaleString("es-CO")} COP en ${gastosEstaSemana.length} transacciones
Semana anterior: $${totalAnterior.toLocaleString("es-CO")} COP en ${gastosSemanaAnterior.length} transacciones
Diferencia: ${diferencia > 0 ? "+" : ""}${diferencia.toLocaleString("es-CO")} COP (${porcentaje > 0 ? "+" : ""}${porcentaje}%)

Categorías esta semana: ${JSON.stringify(
    gastosEstaSemana.reduce((acc, g) => {
      acc[g.categoria] = (acc[g.categoria] || 0) + g.monto;
      return acc;
    }, {})
  )}

Escribe un análisis semanal breve (máximo 120 palabras), amigable, con un consejo específico basado en los datos. Usa emojis.`;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 250,
  });

  return res.choices[0].message.content.trim();
}
