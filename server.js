const express  = require("express");
const cors     = require("cors");
const rateLimit = require("express-rate-limit");
const fetch    = require("node-fetch");
const fs       = require("fs");
const { HttpsProxyAgent } = require("https-proxy-agent");
const admin    = require("firebase-admin");
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// ========================================
// SEGURIDAD — CORS restringido a dominios propios (ago-2026)
// Antes: app.use(cors()) sin argumentos → el backend respondía a CUALQUIER
// web del mundo, permitiendo que un tercero usara este servidor como su
// propio proveedor gratis de scraping de YouTube (gastando el ancho de banda
// de QuotaGuard y arriesgando el bloqueo de la IP fija). Ahora solo se
// aceptan peticiones cuyo Origin sea uno de los dominios de Hache X.
//
// IMPORTANTE: incluir TODOS los dominios reales desde los que se sirve el
// frontend — omitir uno rompe ese dominio por completo. Se pueden agregar
// más sin tocar código con la variable CORS_EXTRA_ORIGINS (lista separada
// por comas) en Render.
//
// Nota: peticiones sin Origin (curl, health checks de Render, apps móviles
// nativas) se permiten a propósito — el navegador es quien envía Origin, y
// bloquear su ausencia rompería el /health que Render usa para el keep-alive.
const ORIGENES_PERMITIDOS = [
  "https://hachexmusic.com",
  "https://www.hachexmusic.com",
  "https://hache-beatlinks.web.app",
  "https://hache-beatlinks.firebaseapp.com",
  "https://hachex-pruebas.web.app",
  ...(process.env.CORS_EXTRA_ORIGINS
      ? process.env.CORS_EXTRA_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
      : [])
];
 
const corsOptions = {
  origin(origin, callback) {
    // Sin Origin (health checks, curl, apps nativas) → permitir.
    if (!origin) return callback(null, true);
    if (ORIGENES_PERMITIDOS.includes(origin)) return callback(null, true);
    // Origin presente pero no permitido → rechazar SIN lanzar excepción
    // (lanzar tumbaría la request con un 500; mejor un CORS limpio que el
    // navegador maneja como corresponde).
    console.warn(`⛔ CORS: origin no permitido → ${origin}`);
    return callback(null, false);
  }
};
 
app.use(cors(corsOptions));
 
// Límite de tamaño del body (antes: express.json() sin límite → alguien
// podía mandar un JSON gigante para consumir memoria). 10kb sobra para el
// body de /genero, que solo lleva titulo, artista y una lista corta de ids.
app.use(express.json({ limit: "10kb" }));
 
// ========================================
// SEGURIDAD — Rate limiting (ago-2026)
// Antes: sin ningún límite → un atacante podía mandar miles de peticiones
// por segundo a /search o /audio (que raspan YouTube por la IP fija de
// QuotaGuard) o a /genero (que cuesta dinero de la API de Anthropic),
// agotando cuota, dinero, o tumbando el servicio para los locales reales.
//
// CRÍTICO — trust proxy: Render pone el servidor detrás de su balanceador,
// así que la IP real del cliente llega en el header X-Forwarded-For. Sin
// esto, express-rate-limit vería a TODOS los clientes como una sola IP (la
// del proxy) y los contaría juntos → bloquearía a todo el mundo de una vez.
// Se confía UN SOLO salto de proxy (el de Render), no una cadena arbitraria,
// que sería falsificable.
app.set("trust proxy", 1);
 
// Los límites están calibrados pensando en que un local entero comparte UNA
// IP (el WiFi del bar): un local lleno con muchas mesas buscando debe pasar
// sin problema, mientras que un bot que dispara miles de peticiones se corta.
// El caché de búsquedas hace que el tráfico real a estos endpoints sea aún
// menor que lo que sugiere el número de clientes.
 
// Endpoints que raspan YouTube (search, check, audio, duration): generoso
// para un local en hora pico, pero un techo firme contra abuso.
const limiteYouTube = rateLimit({
  windowMs: 60 * 1000,     // ventana de 1 minuto
  max: 120,                // 120 peticiones/min por IP (2 por segundo sostenido)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones, espera un momento." }
});
 
// /genero cuesta dinero real (API de Anthropic) — límite más estricto. Aun
// así holgado: en un local normal, la mayoría de canciones ni llegan a
// consultar género (lo resuelve el filtro de palabras o el caché).
const limiteGenero = rateLimit({
  windowMs: 60 * 1000,
  max: 40,                 // 40 verificaciones de género/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas verificaciones de género, espera un momento." }
});
 
 
// 🩹 (ago-2026) HARDENING contra bloqueos de YouTube — incidente del 23 ago
// donde la IP fija de QuotaGuard fue marcada con captcha (HTTP 429) tras
// muy poco tráfico. Dos causas probables identificadas: (1) headers
// demasiado escuetos/siempre idénticos, sin las cookies que un navegador
// real acumula — huella fácil de distinguir de tráfico humano aunque la IP
// sea limpia; (2) posible reputación previa de la IP compartida por
// QuotaGuard en planes no-dedicados (a confirmar con su soporte). Esto
// ataca la causa (1), que es la única que el código puede controlar.
//
// Headers ampliados — antes solo tenían 3 campos, siempre idénticos en cada
// petición; un navegador real manda muchos más y varían por request.
const HEADERS = {
  "User-Agent":               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language":          "es-ES,es;q=0.9,en;q=0.8",
  "Accept":                   "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Encoding":          "gzip, deflate, br",
  "sec-ch-ua":                '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile":         "?0",
  "sec-ch-ua-platform":       '"Windows"',
  "Sec-Fetch-Dest":           "document",
  "Sec-Fetch-Mode":           "navigate",
  "Sec-Fetch-Site":           "none",
  "Sec-Fetch-User":           "?1",
  "Upgrade-Insecure-Requests": "1"
};
 
// ── Cookie jar simple para youtube.com ──────────────────────────────────
// node-fetch no maneja cookies solo — cada petición le llegaba a YouTube
// como visita nueva, sin ni siquiera la cookie CONSENT que un navegador
// real junta desde la primera visita. Esto guarda las cookies que YouTube
// devuelve y las reenvía en la siguiente petición, como haría un navegador.
// Es un jar único compartido (no por usuario) — correcto acá porque quien
// "navega" es el backend mismo, no cada cliente.
let cookieJarYouTube = {};
 
function leerCookiesDeRespuesta(response) {
  const setCookie = typeof response.headers.raw === "function"
    ? response.headers.raw()["set-cookie"]
    : null;
  if (!setCookie) return;
  for (const linea of setCookie) {
    const [par] = linea.split(";");
    const idx = par.indexOf("=");
    if (idx > 0) cookieJarYouTube[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
  }
}
 
function cookieHeaderActual() {
  const entradas = Object.entries(cookieJarYouTube);
  if (!entradas.length) return null;
  return entradas.map(([k, v]) => `${k}=${v}`).join("; ");
}
 
// ── Circuit breaker (por proxy) ──────────────────────────────────────────
// Si YouTube empieza a mostrar el challenge de captcha, seguir insistiendo
// con cada búsqueda nueva no ayuda — puede alargar el bloqueo, y hace que
// cada cliente del bar dispare su propio intento fallido con el timeout
// completo (8s) en vez de fallar rápido. Al detectar el patrón, se deja de
// tocar YouTube por un rato y se responde rápido con el mismo motivo, hasta
// que se cumpla el enfriamiento — momento en que se reintenta solo.
//
// 🩹 (ago-2026 v2) Ahora es POR PROXY, no un único estado global — con
// varias IPs de respaldo en rotación (ver más abajo), que UNA esté en
// enfriamiento no debe impedir probar las otras. Cada proxy (identificado
// por su "etiqueta") tiene su propio reloj de enfriamiento independiente.
const ENFRIAMIENTO_BLOQUEO_MS = 90 * 1000; // 90s
const enfriamientoPorProxy = {}; // { etiqueta: timestamp hasta cuándo esperar }
 
function esRespuestaDeBloqueo(html, status) {
  return status === 429 || /solveSimpleChallenge|id=.?captcha.?/i.test(html || "");
}
 
function marcarPosibleBloqueo(html, status, etiqueta) {
  if (esRespuestaDeBloqueo(html, status)) {
    enfriamientoPorProxy[etiqueta] = Date.now() + ENFRIAMIENTO_BLOQUEO_MS;
    console.warn(`🚫 Patrón de bloqueo detectado en proxy "${etiqueta}" (status ${status}) — pausándolo ${ENFRIAMIENTO_BLOQUEO_MS / 1000}s`);
    return true;
  }
  return false;
}
 
function estaEnEnfriamiento(etiqueta) {
  return Date.now() < (enfriamientoPorProxy[etiqueta] || 0);
}
 
// ========================================
// QuotaGuard Static IP (ago-2026)
// Todas las peticiones a YouTube (search, check, audio, duration) salen a
// través de esta IP fija, en vez de la IP compartida de Render — evita que
// tráfico de otros clientes de Render contamine la reputación de la IP.
// Requiere QUOTAGUARDSTATIC_URL en Render (Environment). Si no está
// configurada, el server sigue funcionando igual (sin proxy).
// ========================================
const QUOTAGUARD_URL = process.env.QUOTAGUARDSTATIC_URL || null;
const proxyAgent = QUOTAGUARD_URL ? new HttpsProxyAgent(QUOTAGUARD_URL) : null;
 
if (proxyAgent) {
  console.log("✅ QuotaGuard Static IP activo — peticiones a YouTube saldrán por IP fija");
} else {
  console.warn("⚠️ QUOTAGUARDSTATIC_URL no configurada — peticiones a YouTube van por IP compartida de Render");
}
 
// ========================================
// 🩹 (ago-2026) Cascada de respaldo para /search — incidente del 23 ago
// Orden acordado con Hache, de más barato a más caro:
//   1. QuotaGuard (tarifa fija ya pagada) — intento normal de siempre.
//   2. API oficial de YouTube Data v3 (gratis, pero tope duro de 100
//      búsquedas/día — UNA sola cuenta, nunca varias: usar más de un
//      proyecto de Google Cloud para multiplicar esa cuota se llama
//      "sharding" y está explícitamente prohibido por los Términos de
//      Servicio de la API de YouTube — puede tumbar todos los proyectos,
//      no solo el de respaldo).
//   3. Proxy residencial (cobra por GB — el más caro, por eso va de último
//      entre los que SÍ intentan resolver la búsqueda).
//   4. Nada funcionó → degradar con el aviso de "intenta en un momento"
//      que ya existía (circuit breaker).
// Cada capa es opcional: si su variable de entorno no está configurada,
// el código simplemente la salta y sigue con la siguiente — igual que ya
// pasa con QuotaGuard hoy.
// ========================================
 
// ── Capa 2: API oficial de YouTube Data v3 ──
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;
const LIMITE_API_DIARIO = 100; // tope real de Google para search.list — no se puede pagar para subirlo
const cuotaAPI = { fecha: null, usadas: 0 };
 
function fechaPacificoHoy() {
  // El cupo de Google resetea a medianoche hora del Pacífico (América/Los_Ángeles),
  // sin importar en qué zona horaria corre Render.
  return new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
}
 
if (YOUTUBE_API_KEY) {
  console.log("✅ API oficial de YouTube configurada — disponible como respaldo (100 búsquedas/día)");
} else {
  console.warn("⚠️ YOUTUBE_API_KEY no configurada — la capa de respaldo con la API oficial queda desactivada");
}
 
// ── Capa 3: proxy residencial ──
const RESIDENTIAL_PROXY_URL = process.env.RESIDENTIAL_PROXY_URL || null;
const residentialProxyAgent = RESIDENTIAL_PROXY_URL ? new HttpsProxyAgent(RESIDENTIAL_PROXY_URL) : null;
 
if (residentialProxyAgent) {
  console.log("✅ Proxy residencial configurado — disponible como último respaldo antes de degradar");
} else {
  console.warn("⚠️ RESIDENTIAL_PROXY_URL no configurada — la capa de respaldo residencial queda desactivada");
}
 
// ── Capa 1: lista rotativa de proxies de centro de datos ──
// QuotaGuard es el principal (ya pagado, va primero). Cada correo/cuenta
// nueva que Hache consiga con OTRO proveedor de IP fija se agrega acá sin
// tocar el resto del código — solo definiendo su variable de entorno
// correspondiente en Render (PROXY_RESPALDO_2_URL, _3_URL, _4_URL, _5_URL). Si
// alguna no está configurada, simplemente no entra en la rotación.
const proxiesDatacenter = [];
if (proxyAgent) proxiesDatacenter.push({ agente: proxyAgent, etiqueta: "quotaguard" });
 
// 🩹 (ago-2026 v3) Sin tope fijo — Hache decidió no limitar cuántas IPs de
// respaldo puede tener (empieza con 10 dedicadas de Webshare, pero puede
// crecer). En vez de una lista fija [2,3,4,5], recorre hasta 20 posiciones
// — las que no tengan variable configurada simplemente no entran a la
// rotación, así que agregar la 6ª, 7ª... IP en el futuro es solo pegar su
// URL en Render, cero cambios de código.
for (let n = 2; n <= 20; n++) {
  const url = process.env[`PROXY_RESPALDO_${n}_URL`];
  if (url) {
    proxiesDatacenter.push({ agente: new HttpsProxyAgent(url), etiqueta: `respaldo_${n}` });
    console.log(`✅ Proxy de respaldo #${n} configurado (PROXY_RESPALDO_${n}_URL) — ${n}º en la rotación`);
  }
}
 
console.log(`✅ ${proxiesDatacenter.length} proxy(s) de centro de datos en rotación para /search`);
 
// ========================================
// Firebase Admin — caché de búsquedas (ago-2026)
// Antes de raspar YouTube en /search, se consulta si esa misma búsqueda ya
// fue resuelta en los últimos CACHE_TTL_MS — si sí, se devuelve el caché y
// YouTube ni se toca. Reduce drásticamente el volumen de scraping, que es
// la causa raíz del riesgo de bloqueo (el proxy de arriba ataca el síntoma
// de la IP; esto ataca el volumen de peticiones en sí).
//
// Usa el service account en /etc/secrets/firebase-service-account.json
// (Secret File de Render) — NUNCA se sube al repo. Si el archivo no está
// presente (ej. corriendo en local sin configurarlo), el caché queda
// desactivado y el server sigue funcionando exactamente como antes: nunca
// se rompe una búsqueda por falta de Firebase.
// ========================================
const SERVICE_ACCOUNT_PATH = "/etc/secrets/firebase-service-account.json";
const CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 días
 
// 🎯 (ago-2026) TTL corto para búsquedas que dieron 0 resultados. Se cachean
// igual que cualquier búsqueda real (evita que un typo o una canción rara se
// re-busque en YouTube cada vez que alguien la repite), pero con vida corta:
// si en 6h nadie más la busca, vence y se reintenta en YouTube — porque un
// "0 resultados" puede ser un glitch pasajero de YouTube, no necesariamente
// que la canción no exista. 15 días sería demasiado tiempo para dejar una
// búsqueda posiblemente válida marcada como "sin resultados".
const CACHE_TTL_VACIO_MS = 6 * 60 * 60 * 1000; // 6 horas
 
// 🎯 (ago-2026) Guarda en caché CON reintento — antes era fire-and-forget
// con un solo intento: si esa escritura a Firebase fallaba (blip de red,
// lo que sea), la búsqueda se le servía bien al cliente pero JAMÁS quedaba
// cacheada — la siguiente persona que pidiera lo mismo volvía a tocar
// YouTube sin que nadie se enterara del fallo. Ahora reintenta una vez tras
// una pausa corta antes de darse por vencido. Sigue sin bloquear la
// respuesta al cliente (se llama sin esperarla con await).
async function guardarEnCacheConReintento(cacheRef, datos, intento = 1) {
  try {
    await cacheRef.set(datos);
  } catch (err) {
    if (intento === 1) {
      console.warn(`⚠️ Fallo guardando en caché (intento 1), reintentando en 1.5s: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500));
      return guardarEnCacheConReintento(cacheRef, datos, 2);
    }
    console.error(`⚠️ Fallo guardando en caché tras 2 intentos — esta búsqueda NO quedó cacheada: ${err.message}`);
  }
}
 
let db = null;
 
if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  try {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://hache-beatlinks-default-rtdb.firebaseio.com"
    });
    db = admin.database();
    console.log("✅ Firebase Admin conectado — caché de búsquedas activo");
  } catch (err) {
    console.error("⚠️ Error inicializando Firebase Admin — caché desactivado:", err.message);
  }
} else {
  console.warn("⚠️ firebase-service-account.json no encontrado — caché de búsquedas desactivado, todo va directo a YouTube");
}
 
// ========================================
// Convierte el texto de búsqueda en una clave estable de caché para Firebase.
// ========================================
function normalizarClaveCache(query) {
  const norm = (query == null ? "" : String(query))
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // acentos/diacríticos
    .replace(/['’`´]/g, "")                            // apóstrofes/comillas: eliminar, no separar
    .replace(/[^a-z0-9]+/g, " ")                       // cualquier otro signo → espacio
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return "_vacio";                          // consultas solo-signos/vacías: clave estable
  const palabras = norm.split(" ").filter(w => w.length > 0).sort();
  return palabras.join("_").substring(0, 200);
}
 
// ========================================
// Helper: fetch con timeout — evita que requests colgadas se acumulen en
// memoria hasta tumbar la instancia (causa confirmada de "Ran out of memory").
// Todo fetch del servidor DEBE pasar por aquí.
//
// viaProxy (default true): si hay QuotaGuard configurado, la petición sale
// por esa IP fija. Pasar viaProxy:false para las que NO son a YouTube (ej.
// la llamada a la API de Anthropic en /genero).
// ========================================
async function fetchConTimeout(url, options = {}, timeoutMs = 8000, viaProxy = true, agenteOverride = null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const finalOptions = { ...options, signal: ctrl.signal };
    // 🩹 (ago-2026 v2) agenteOverride permite forzar un proxy específico de
    // la rotación (ver proxiesDatacenter / residentialProxyAgent) en vez de
    // siempre usar el de QuotaGuard por defecto — necesario para la cascada
    // de respaldo de /search.
    const agente = agenteOverride || (viaProxy ? proxyAgent : null);
    if (agente) {
      finalOptions.agent = agente;
    }
    // 🩹 (ago-2026) Reenviar las cookies acumuladas de YouTube — ver cookie
    // jar más arriba. Solo aplica a peticiones a youtube.com (no a Anthropic).
    const esYoutube = url.includes("youtube.com");
    if (esYoutube) {
      const cookieHeader = cookieHeaderActual();
      if (cookieHeader) {
        finalOptions.headers = { ...(finalOptions.headers || {}), "Cookie": cookieHeader };
      }
    }
    const response = await fetch(url, finalOptions);
    if (esYoutube) leerCookiesDeRespuesta(response);
    return response;
  } finally {
    clearTimeout(t);
  }
}
 
// ========================================
// GET /health
// ========================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Hache X Backend",
    quotaguard: !!proxyAgent,
    proxiesDatacenter: proxiesDatacenter.map(p => p.etiqueta),
    apiOficial: !!YOUTUBE_API_KEY,
    proxyResidencial: !!residentialProxyAgent,
    cache: !!db
  });
});
 
// ========================================
// GET /estado-proxies
// 🩹 (ago-2026) Pedido de Hache: panel de admin que muestra cuántas IPs
// están disponibles AHORA MISMO (ninguna en enfriamiento) vs cuántas están
// pausadas por un bloqueo reciente. Es estado en vivo del proceso (vive en
// memoria, no en Firebase) — por eso es un endpoint aparte, no un dato que
// se pueda leer directo desde admin.html.
// ========================================
app.get("/estado-proxies", (req, res) => {
  const proxies = proxiesDatacenter.map(p => ({
    etiqueta: p.etiqueta,
    disponible: !estaEnEnfriamiento(p.etiqueta)
  }));
 
  const hoy = fechaPacificoHoy();
  const apiUsadasHoy = (cuotaAPI.fecha === hoy) ? cuotaAPI.usadas : 0;
 
  res.json({
    proxies,
    totalProxies: proxies.length,
    disponiblesAhora: proxies.filter(p => p.disponible).length,
    apiOficial: YOUTUBE_API_KEY
      ? { usadasHoy: apiUsadasHoy, limite: LIMITE_API_DIARIO, disponible: apiUsadasHoy < LIMITE_API_DIARIO }
      : null,
    proxyResidencial: !!residentialProxyAgent
  });
});
 
// ========================================
// Scraping de /results — función compartida entre TODOS los proxies de la
// cascada (capa 1: cada uno de proxiesDatacenter; capa 3: residencial).
// Devuelve el arreglo de videos, o null si falló (y en ese caso ya marcó el
// posible bloqueo de ESTE proxy puntual en el circuit breaker).
// ========================================
async function intentarScrapeYouTube(query, agente, etiqueta) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response  = await fetchConTimeout(searchUrl, { headers: HEADERS }, 8000, false, agente);
    const html      = await response.text();
    const match     = html.match(/var ytInitialData = ({.*?});/s);
    if (!match) {
      console.error(`⚠️ /search (${etiqueta}): no se pudo parsear "${query}" — status HTTP: ${response.status}`);
      console.error(`⚠️ /search (${etiqueta}): primeros 500 caracteres de la respuesta:`, html.slice(0, 500));
      marcarPosibleBloqueo(html, response.status, etiqueta);
      return null;
    }
 
    const data     = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
 
    const videos = contents
      .filter(c => c.videoRenderer)
      .slice(0, 20)
      .map(c => {
        const v = c.videoRenderer;
        return {
          videoId:   v.videoId,
          title:     v.title?.runs?.[0]?.text || "",
          channel:   v.ownerText?.runs?.[0]?.text || "",
          thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
          duration:  v.lengthText?.simpleText || ""
        };
      });
 
    console.log(`✅ /search (${etiqueta}): "${query}" — ${videos.length} resultados`);
    return videos;
  } catch (err) {
    console.error(`⚠️ /search (${etiqueta}): error — ${err.message}`);
    return null;
  }
}
 
// ========================================
// Capa 2: API oficial de YouTube Data v3 — respaldo gratuito de UNA sola
// cuenta, respetando su tope real de 100 búsquedas/día (ver comentario
// largo junto a YOUTUBE_API_KEY, arriba). No usa proxy — va directo, es
// tráfico legítimo hacia la API oficial de Google, no scraping.
// ========================================
async function buscarViaAPIOficial(query) {
  if (!YOUTUBE_API_KEY) return null;
 
  const hoy = fechaPacificoHoy();
  if (cuotaAPI.fecha !== hoy) { cuotaAPI.fecha = hoy; cuotaAPI.usadas = 0; }
 
  if (cuotaAPI.usadas >= LIMITE_API_DIARIO) {
    console.warn(`⚠️ /search: cuota diaria de la API oficial agotada (${LIMITE_API_DIARIO}/día) — saltando a la siguiente capa`);
    return null;
  }
 
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const res = await fetchConTimeout(url, {}, 8000, false);
    cuotaAPI.usadas++; // se cuenta el intento, tenga éxito o no — así lo cobra Google
 
    if (!res.ok) {
      const cuerpo = await res.text().catch(() => "");
      console.warn(`⚠️ /search (api_oficial): status ${res.status} — ${cuerpo.slice(0, 200)}`);
      return null;
    }
 
    const data = await res.json();
    const videos = (data.items || [])
      .filter(it => it.id?.videoId)
      .map(it => ({
        videoId:   it.id.videoId,
        title:     it.snippet?.title || "",
        channel:   it.snippet?.channelTitle || "",
        thumbnail: it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.default?.url || "",
        duration:  "" // search.list no trae duración; pedirla aparte costaría cuota extra
      }));
 
    console.log(`✅ /search (api_oficial): "${query}" — ${videos.length} resultados (${cuotaAPI.usadas}/${LIMITE_API_DIARIO} hoy)`);
    return videos;
  } catch (err) {
    console.error(`⚠️ /search (api_oficial): error — ${err.message}`);
    return null;
  }
}
 
// ========================================
// GET /search?q=nombre+artista
// ========================================
app.get("/search", limiteYouTube, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Falta el parámetro q" });
 
  const clave = normalizarClaveCache(query);
  const cacheRef = db ? db.ref(`cacheBusquedas/${clave}`) : null;
 
  try {
    // ── Intentar servir desde caché ──
    if (cacheRef) {
      try {
        const snapshot = await cacheRef.once("value");
        const cacheado = snapshot.val();
        if (cacheado) {
          const ttlAplicable = cacheado.vacio ? CACHE_TTL_VACIO_MS : CACHE_TTL_MS;
          const vigente = (Date.now() - cacheado.timestamp) < ttlAplicable;
          if (vigente && cacheado.videos) {
            console.log(`💾 /search: "${query}" servido desde caché (${cacheado.videos.length} resultados${cacheado.vacio ? ", vacío" : ""})`);
            cacheRef.update({ timestamp: Date.now() })
              .catch(err => console.error("⚠️ Error renovando timestamp de caché:", err.message));
            return res.json({ videos: cacheado.videos, cache: true });
          }
        }
      } catch (err) {
        console.error("⚠️ Error leyendo caché, se sigue con YouTube directo:", err.message);
      }
    }
 
    // ── No hay caché válido: cascada de respaldo ──
    // 🩹 (ago-2026 v2) Orden acordado con Hache — de más barato a más caro:
    //   1. proxiesDatacenter (QuotaGuard + respaldos de otros proveedores),
    //      probados en orden, saltando cualquiera que esté en enfriamiento.
    //   2. API oficial de YouTube (gratis, una sola cuenta, 100/día).
    //   3. Proxy residencial (cobra por GB — el más caro, va de último).
    //   4. Nada funcionó → degradar con el aviso de "intenta en un momento".
    let videos = null;
    let fuente = null;
 
    for (const { agente, etiqueta } of proxiesDatacenter) {
      if (estaEnEnfriamiento(etiqueta)) {
        console.warn(`🚫 /search: "${query}" — proxy "${etiqueta}" en enfriamiento, probando el siguiente`);
        continue;
      }
      videos = await intentarScrapeYouTube(query, agente, etiqueta);
      if (videos) { fuente = etiqueta; break; }
    }
 
    if (!videos) {
      videos = await buscarViaAPIOficial(query);
      if (videos) fuente = "api_oficial";
    }
 
    if (!videos && residentialProxyAgent) {
      videos = await intentarScrapeYouTube(query, residentialProxyAgent, "residencial");
      if (videos) fuente = "residencial";
    }
 
    if (!videos) {
      return res.status(503).json({ error: "YouTube está limitando peticiones temporalmente, reintenta en un momento", enfriamiento: true });
    }
 
    if (cacheRef) {
      const datos = { query, videos, timestamp: Date.now() };
      if (videos.length === 0) datos.vacio = true;
      guardarEnCacheConReintento(cacheRef, datos);
    }
 
    // 🩹 (ago-2026) Registro para el panel de admin — dos cosas pedidas por
    // Hache que antes no se guardaban en ningún lado:
    //   1. busquedasEnVivo/{clave}: qué búsquedas tuvieron que tocar YouTube
    //      de verdad (no venían de caché) — el panel "Búsquedas nuevas" de
    //      admin.html estaba vacío porque este dato nunca se escribía.
    //   2. estadisticasProxy/{fuente}: cuántas veces se usó cada IP/API hoy
    //      y cuándo fue la última vez — para el panel nuevo de "IPs en uso".
    // Ambas son fire-and-forget (no bloquean la respuesta al cliente) y
    // usan la misma "clave" normalizada que ya existe para el caché, así
    // que no crecen sin límite: una búsqueda repetida actualiza su propia
    // entrada en vez de crear una nueva cada vez.
    if (db && fuente) {
      db.ref(`busquedasEnVivo/${clave}`).set({ query, fuente, timestamp: Date.now() })
        .catch(err => console.error("⚠️ Error registrando búsqueda en vivo:", err.message));
      db.ref(`estadisticasProxy/${fuente}`).transaction(actual => {
        actual = actual || { usos: 0 };
        actual.usos = (actual.usos || 0) + 1;
        actual.ultimoUso = Date.now();
        return actual;
      }).catch(err => console.error("⚠️ Error registrando estadística de proxy:", err.message));
    }
 
    res.json({ videos, cache: false, fuente });
  } catch (err) {
    console.error("Error en /search:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
 
// ========================================
// GET /check?videoId=XXX
// ========================================
app.get("/check", limiteYouTube, async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });
 
  try {
    const innertubeRes = await fetchConTimeout(
      "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Origin":       "https://www.youtube.com",
          "Referer":      "https://www.youtube.com/"
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName:    "WEB",
              clientVersion: "2.20240101.00.00",
              hl: "es",
              gl: "CO"
            }
          }
        })
      },
      5000
    );
 
    const playerData = await innertubeRes.json();
    const status = playerData?.playabilityStatus?.status;
 
    if (status === "ERROR" || status === "LOGIN_REQUIRED" || status === "UNPLAYABLE") {
      return res.json({ embeddable: false, reason: status });
    }
 
    const playableInEmbed = playerData?.playabilityStatus?.playableInEmbed;
    const embeddable = playableInEmbed !== false;
 
    res.json({ embeddable, reason: embeddable ? null : "EMBED_RESTRICTED" });
  } catch (err) {
    console.error("Error en /check:", err.message);
    res.status(500).json({ error: "Error interno del servidor", embeddable: true });
  }
});
 
// ========================================
// GET /audio?videoId=XXX
// ========================================
app.get("/audio", limiteYouTube, async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });
 
  try {
    const innertubeRes = await fetchConTimeout("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Origin":       "https://www.youtube.com",
        "Referer":      "https://www.youtube.com/"
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:    "ANDROID",
            clientVersion: "19.09.37",
            androidSdkVersion: 30,
            hl: "es",
            gl: "CO"
          }
        }
      })
    });
 
    const playerData = await innertubeRes.json();
 
    const status = playerData?.playabilityStatus?.status;
    if (status === "ERROR" || status === "LOGIN_REQUIRED" || status === "UNPLAYABLE") {
      console.warn(`⚠️ Video no disponible: ${videoId} — status: ${status}`);
      return res.status(403).json({ error: "Video no disponible", status });
    }
 
    const audioFormats = (playerData?.streamingData?.adaptiveFormats || [])
      .filter(f => f.mimeType && f.mimeType.startsWith("audio/") && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
 
    if (audioFormats.length > 0) {
      const best = audioFormats[0];
      const duration = parseInt(playerData?.videoDetails?.lengthSeconds || 0);
      const title    = playerData?.videoDetails?.title || "";
      console.log(`✅ Audio extraído: ${title} — ${best.mimeType} ${best.bitrate}bps`);
      return res.json({
        url:      best.url,
        mimeType: best.mimeType,
        bitrate:  best.bitrate,
        duration,
        title
      });
    }
 
    console.log("⚠️ Innertube no dio formatos, intentando scraping...");
    const pageRes  = await fetchConTimeout(`https://www.youtube.com/watch?v=${videoId}`, { headers: HEADERS });
    const html     = await pageRes.text();
    // 🩹 (ago-2026) Mismo detector de bloqueo que /search — ver comentario
    // junto al circuit breaker, arriba del archivo.
    marcarPosibleBloqueo(html, pageRes.status, "quotaguard");
    const prMatch  = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s);
    if (!prMatch) return res.status(500).json({ error: "No se pudo extraer player response" });
 
    const pr = JSON.parse(prMatch[1]);
    const formats2 = (pr?.streamingData?.adaptiveFormats || [])
      .filter(f => f.mimeType && f.mimeType.startsWith("audio/") && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
 
    if (formats2.length > 0) {
      const best2    = formats2[0];
      const duration2 = parseInt(pr?.videoDetails?.lengthSeconds || 0);
      return res.json({ url: best2.url, mimeType: best2.mimeType, bitrate: best2.bitrate, duration: duration2 });
    }
 
    return res.status(404).json({ error: "No se encontraron formatos de audio" });
 
  } catch(e) {
    console.error("Error /audio:", e.message);
    res.status(500).json({ error: "Error interno", detail: e.message });
  }
});
 
// ========================================
// GET /duration?videoId=XXX
// ========================================
app.get("/duration", limiteYouTube, async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });
 
  // 🩹 (ago-2026) Mismo circuit breaker que /search — usa la etiqueta del
  // proxy principal, ya que /duration solo pasa por QuotaGuard, no por toda
  // la cascada de respaldo (esa es específica de /search).
  if (estaEnEnfriamiento("quotaguard")) {
    return res.status(503).json({ error: "YouTube está limitando peticiones temporalmente, reintenta en un momento", enfriamiento: true });
  }
 
  try {
    const url      = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetchConTimeout(url, { headers: HEADERS });
    const html     = await response.text();
    marcarPosibleBloqueo(html, response.status, "quotaguard");
 
    const patterns = [/"lengthSeconds":"(\d+)"/, /"lengthSeconds":(\d+)/, /lengthSeconds\\?":\\?"(\d+)/];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const duration = parseInt(match[1]);
        if (duration > 0) return res.json({ duration });
      }
    }
 
    const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s);
    if (prMatch) {
      try {
        const pr  = JSON.parse(prMatch[1]);
        const dur = pr?.videoDetails?.lengthSeconds;
        if (dur) return res.json({ duration: parseInt(dur) });
      } catch(e) {}
    }
 
    res.status(404).json({ error: "No se encontró duración" });
  } catch(e) {
    res.status(500).json({ error: "Error interno" });
  }
});
 
// ========================================
// POST /genero
// ========================================
const ANTHROPIC_TIMEOUT_MS = 4000;
 
function construirPromptGenero(titulo, artista, listaGeneros) {
  return `Cancion: "${titulo}"${artista ? ` — Artista/canal: "${artista}"` : ""}
 
Generos permitidos hoy: ${listaGeneros}
 
Responde EXCLUSIVAMENTE con el id exacto de UNO de los generos permitidos de la lista de arriba si la cancion pertenece claramente a ese genero — aqui si reconoces la cancion o el artista, aunque sea parcialmente o por un nombre de canal poco claro, responde con tu mejor clasificacion en vez de dudar.
 
NO_COINCIDE es una decision seria: bloquea a un cliente real de un bar en el momento en que esta pidiendo su cancion. Uselo UNICAMENTE cuando esta SEGURO de cual es el genero real de la cancion Y ese genero claramente no es ninguno de los permitidos (ej: reconoce que es reggaeton y reggaeton no esta en la lista). Si el artista le resulta poco conocido, no esta seguro de su genero exacto, o solo tiene una sospecha sin certeza real, NO use NO_COINCIDE — responda INSEGURO en su lugar. Ante cualquier duda genuina sobre el genero real de la cancion, la respuesta correcta es INSEGURO, nunca NO_COINCIDE.
 
No agregues explicaciones ni texto adicional — responde solo esa palabra, nada mas.`;
}
 
async function preguntarleAClaude(prompt, modelo) {
  const aiRes = await fetchConTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-api-key":        process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model:      modelo,
        max_tokens: 20,
        messages:   [{ role: "user", content: prompt }]
      })
    },
    ANTHROPIC_TIMEOUT_MS,
    false
  );
 
  if (!aiRes.ok) {
    const cuerpoError = await aiRes.text().catch(() => "(no se pudo leer el cuerpo)");
    console.error(`⚠️ /genero (${modelo}): Anthropic respondió status ${aiRes.status} — ${cuerpoError}`);
    return null;
  }
 
  const data = await aiRes.json();
  return (data?.content?.[0]?.text || "").trim();
}
 
app.post("/genero", limiteGenero, async (req, res) => {
  const { titulo, artista, generos, segundaOpinion } = req.body || {};
 
  if (!titulo || !Array.isArray(generos) || generos.length === 0) {
    return res.status(400).json({ error: "Faltan datos (titulo, generos)" });
  }
 
  if (typeof titulo !== "string" || titulo.length > 300) {
    return res.status(400).json({ error: "titulo inválido" });
  }
  if (artista != null && (typeof artista !== "string" || artista.length > 300)) {
    return res.status(400).json({ error: "artista inválido" });
  }
  if (generos.length > 50 || !generos.every(g => typeof g === "string" && g.length <= 40)) {
    return res.status(400).json({ error: "generos inválidos" });
  }
 
  console.log(`🎵 /genero: "${titulo}" — "${artista || "?"}" | permitidos: ${generos.join(",")} | segundaOpinion=${!!segundaOpinion}`);
 
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️ ANTHROPIC_API_KEY no configurada — /genero responde sin verificar");
    return res.json({ genero: null });
  }
 
  const listaGeneros = generos.join(", ");
  const prompt = construirPromptGenero(titulo, artista, listaGeneros);
 
  try {
    let texto = await preguntarleAClaude(prompt, "claude-haiku-4-5-20251001");
    if (texto === null) return res.json({ genero: null });
 
    console.log(`🎵 /genero: "${titulo}" → Haiku respondió "${texto}"`);
 
    const haikuBloquearia = texto === "NO_COINCIDE" || !generos.includes(texto);
    if (haikuBloquearia && segundaOpinion === true) {
      const textoSonnet = await preguntarleAClaude(prompt, "claude-sonnet-5");
      if (textoSonnet !== null) {
        console.log(`🎵 /genero: "${titulo}" → segunda opinión Sonnet respondió "${textoSonnet}"`);
        texto = textoSonnet;
      }
    }
 
    if (texto === "NO_COINCIDE") return res.json({ genero: "NO_COINCIDE" });
    if (!generos.includes(texto)) {
      if (texto !== "INSEGURO") console.warn(`⚠️ /genero: respuesta inesperada ("${texto}"), tratando como insegura`);
      return res.json({ genero: null });
    }
 
    return res.json({ genero: texto });
 
  } catch (err) {
    console.error(`Error en /genero ("${titulo}"):`, err.message);
    return res.json({ genero: null });
  }
});
 
app.listen(PORT, () => {
  console.log(`✅ Hache X Backend corriendo en puerto ${PORT}`);
});
