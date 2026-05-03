# 💰 GastosBot — Bot de Telegram para control de gastos con IA

Bot de Telegram que registra gastos por voz o texto, categoriza automáticamente con IA, y genera resúmenes inteligentes en español colombiano.

## Stack
- **Groq** (Whisper para transcripción + Llama para análisis) — gratis
- **Firebase Firestore** (base de datos de usuarios y gastos) — gratis
- **Netlify Functions** (servidor serverless) — gratis
- **Telegram Bot API** — gratis

---

## 🚀 Despliegue paso a paso

### 1. Crear el bot en Telegram

1. Abre Telegram y busca **@BotFather**
2. Escribe `/newbot`
3. Dale un nombre: `GastosBot` (o el que quieras)
4. Dale un username: `tu_gastos_bot` (debe terminar en "bot")
5. Copia el **token** que te da — lo necesitarás

### 2. Obtener la API Key de Groq

1. Ve a [console.groq.com](https://console.groq.com)
2. Crea una cuenta gratuita
3. Ve a **API Keys** → **Create API Key**
4. Copia la key

### 3. Configurar Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com)
2. Crea un proyecto nuevo (ej: `gastosbot`)
3. Ve a **Firestore Database** → **Crear base de datos** → Modo producción
4. Ve a ⚙️ **Configuración del proyecto** → **Cuentas de servicio**
5. Clic en **Generar nueva clave privada**
6. Descarga el JSON — lo necesitarás

### 4. Subir a GitHub y conectar Netlify

1. Crea un repositorio en GitHub y sube este código
2. Ve a [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**
3. Selecciona tu repositorio
4. En **Build settings**: deja todo en blanco (ya está configurado en `netlify.toml`)
5. Clic en **Deploy site**

### 5. Configurar variables de entorno en Netlify

En tu sitio de Netlify → **Site configuration** → **Environment variables** → agrega:

| Variable | Valor |
|---|---|
| `TELEGRAM_TOKEN` | Token de @BotFather |
| `GROQ_API_KEY` | Tu API key de Groq |
| `FIREBASE_SERVICE_ACCOUNT` | Contenido del JSON en una sola línea |
| `SETUP_SECRET` | Cualquier string secreto que inventes |

Para convertir el JSON de Firebase a una sola línea, en tu terminal:
```bash
cat firebase-service-account.json | tr -d '\n'
```

### 6. Registrar el webhook de Telegram

Una vez desplegado, abre en el navegador:
```
https://TU-SITIO.netlify.app/.netlify/functions/setup?secret=TU_SETUP_SECRET
```

Deberías ver un JSON con `"ok": true`. ¡El bot ya está activo!

---

## 💬 Cómo usar el bot

Busca tu bot en Telegram y escribe `/start`.

**Registrar un gasto:**
- `"Gasté 15 mil en almuerzo"`
- `"Pagué 100 lucas de taxi"`
- O manda un **audio de voz** diciendo lo mismo

**Comandos:**
- `/hoy` — resumen de hoy
- `/semana` — últimos 7 días
- `/mes` — mes actual
- `/pro` — activar plan ilimitado
- `/ayuda` — ver ayuda

---

## 💰 Monetización

**Plan gratuito:** 20 registros
**Plan Pro:** $15.000 COP/mes — registros ilimitados

Para activar Pro manualmente en Firebase:
1. Ve a Firestore → colección `users` → documento del usuario
2. Cambia `plan` de `"free"` a `"pro"`

---

## 📁 Estructura del proyecto

```
gastos-bot/
├── netlify/
│   └── functions/
│       ├── webhook.js      ← Cerebro del bot
│       ├── setup.js        ← Registrar webhook (usar una vez)
│       └── lib/
│           ├── ai.js       ← Groq: transcripción y análisis
│           ├── firebase.js ← Base de datos
│           └── telegram.js ← Enviar mensajes
├── public/
│   └── index.html          ← Landing page
├── netlify.toml
├── package.json
└── .env.example
```
