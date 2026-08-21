const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const fs       = require("fs");
const { HttpsProxyAgent } = require("https-proxy-agent");
const admin    = require("firebase-admin");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Headers comunes para simular navegador
const HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "es-ES,es;q=0.9",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

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

// Convierte el texto de búsqueda en una key válida para Firebase RTDB
// (no admite ".", "#", "$", "[", "]", "/"). Minúsculas + espacios a "_" para
// que "Bad Bunny" y "bad   bunny" caigan en la MISMA entrada de caché.
function normalizarClaveCache(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[.#$\[\]\/]/g, "")
    .substring(0, 200);
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
async function fetchConTimeout(url, options = {}, timeoutMs = 8000, viaProxy = true) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const finalOptions = { ...options, signal: ctrl.signal };
    if (viaProxy && proxyAgent) {
      finalOptions.agent = proxyAgent;
    }
    return await fetch(url, finalOptions);
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
    cache: !!db
  });
});

// ========================================
// GET /search?q=nombre+artista
// Primero consulta el caché de Firebase (cacheBusquedas). Si hay una
// entrada vigente (menos de CACHE_TTL_MS), la devuelve directo — YouTube ni
// se toca. Si no hay caché o venció, raspa YouTube como siempre y guarda el
// resultado nuevo para la próxima vez (fire-and-forget: no bloquea la
// respuesta al cliente si Firebase tarda en escribir).
// ========================================
app.get("/search", async (req, res) => {
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
        if (cacheado && cacheado.videos && (Date.now() - cacheado.timestamp) < CACHE_TTL_MS) {
          console.log(`💾 /search: "${query}" servido desde caché (${cacheado.videos.length} resultados)`);
          // Renovar el timestamp en cada hit (fire-and-forget) — una
          // búsqueda con demanda activa nunca vence mientras la sigan
          // pidiendo; solo vencen las que de verdad dejaron de buscarse.
          cacheRef.update({ timestamp: Date.now() })
            .catch(err => console.error("⚠️ Error renovando timestamp de caché:", err.message));
          return res.json({ videos: cacheado.videos, cache: true });
        }
      } catch (err) {
        // Si falla la lectura del caché, seguir con scraping normal —
        // nunca dejar al cliente sin resultados por un problema de Firebase.
        console.error("⚠️ Error leyendo caché, se sigue con YouTube directo:", err.message);
      }
    }

    // ── No hay caché válido: raspar YouTube ──
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response  = await fetchConTimeout(searchUrl, { headers: HEADERS });
    const html      = await response.text();
    const match     = html.match(/var ytInitialData = ({.*?});/s);
    if (!match) {
      // 🔍 Diagnóstico temporal (ago-2026): antes solo se sabía que falló el
      // parseo, no POR QUÉ. Esto revela si YouTube está devolviendo un
      // captcha/verificación de bot, una página de consentimiento, un error
      // HTTP, o si de verdad cambió su estructura — sin esto es adivinar.
      console.error(`⚠️ /search: no se pudo parsear "${query}" — status HTTP: ${response.status}`);
      console.error(`⚠️ /search: primeros 500 caracteres de la respuesta:`, html.slice(0, 500));
      return res.status(500).json({ error: "No se pudo parsear YouTube", statusYoutube: response.status });
    }

    const data     = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    // 🩹 (ago-2026) Antes se tomaban solo los primeros 6 — YouTube ya trae
    // muchos más en la MISMA respuesta que se descargó, así que subir este
    // tope a 20 no agrega ni una sola petición nueva a YouTube: solo se lee
    // más de lo que ya llegó. Pedido del DJ: en hora pico, con solo 2-3
    // letras necesita ver varias opciones, no 5-6.
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

    // ── Guardar en caché para la próxima vez (no bloquea la respuesta) ──
    if (cacheRef && videos.length > 0) {
      cacheRef.set({
        query,
        videos,
        timestamp: Date.now()
      }).catch(err => console.error("⚠️ Error guardando en caché:", err.message));
    }

    res.json({ videos, cache: false });
  } catch (err) {
    console.error("Error en /search:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ========================================
// GET /check?videoId=XXX
// Verifica si un video es embebible fuera de YouTube usando el mismo
// innertube API oficial (cliente WEB), leyendo el campo real
// playabilityStatus.playableInEmbed. Es la fuente de verdad de YouTube,
// no una suposición — así el frontend puede decidir con anticipación si
// manda el video por Invidious en lugar de esperar a que YouTube falle
// visiblemente frente al público.
// ========================================
app.get("/check", async (req, res) => {
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
      // El video ni siquiera existe/reproduce — no es un tema de embed.
      return res.json({ embeddable: false, reason: status });
    }

    const playableInEmbed = playerData?.playabilityStatus?.playableInEmbed;
    // Campo ausente → asumir embebible (comportamiento conservador: mejor
    // intentar YouTube normal que mandar de más a Invidious).
    const embeddable = playableInEmbed !== false;

    res.json({ embeddable, reason: embeddable ? null : "EMBED_RESTRICTED" });
  } catch (err) {
    console.error("Error en /check:", err.message);
    // Ante cualquier fallo, responder embeddable:true — el frontend ya
    // tiene su propio timeout de 3s y trata el error igual: sigue con
    // YouTube normal en vez de bloquear la reproducción.
    res.status(500).json({ error: "Error interno del servidor", embeddable: true });
  }
});

// ========================================
// GET /audio?videoId=XXX
// Extrae URL directa del audio desde YouTube
// sin yt-dlp, usando ytInitialPlayerResponse
// ========================================
app.get("/audio", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });

  try {
    // Método 1: innertube API (más estable)
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

    // Verificar si el video existe
    const status = playerData?.playabilityStatus?.status;
    if (status === "ERROR" || status === "LOGIN_REQUIRED" || status === "UNPLAYABLE") {
      console.warn(`⚠️ Video no disponible: ${videoId} — status: ${status}`);
      return res.status(403).json({ error: "Video no disponible", status });
    }

    // Buscar formatos de solo audio (mejor calidad primero)
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

    // Método 2: raspar la página como fallback
    console.log("⚠️ Innertube no dio formatos, intentando scraping...");
    const pageRes  = await fetchConTimeout(`https://www.youtube.com/watch?v=${videoId}`, { headers: HEADERS });
    const html     = await pageRes.text();
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
app.get("/duration", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });

  try {
    const url      = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetchConTimeout(url, { headers: HEADERS });
    const html     = await response.text();

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
// Segunda opinión de género vía IA (Claude Haiku), usada SOLO cuando el
// filtro de palabras clave del frontend no pudo confirmar por sí solo el
// género de una canción (ni a favor ni en contra). Body: { titulo, artista,
// generos: [ids permitidos hoy], segundaOpinion: true|false }.
//
// DOS PISOS (ago-2026): Haiku responde siempre primero (rápido). Si Haiku
// dice INSEGURO y el llamador pidió segundaOpinion:true, se le pregunta a
// Sonnet como árbitro antes de decidir — más preciso en artistas poco
// conocidos, a cambio de 1-3s extra SOLO en ese caso ambiguo (la mayoría de
// las canciones las resuelve Haiku solo, sin ese costo). Si Haiku ya
// respondió con confianza (coincide o no_coincide), Sonnet ni se consulta.
//
// Quién pide segundaOpinion:true — usuarios.html (verificarFiltroGenero):
// hay un cliente real esperando en el momento, vale la pena la precisión
// extra para no bloquear por error (caso real: "Magia Rosa" de Viti Ruiz).
// Quién NO la pide (segundaOpinion:false u omitido) — el Piloto Automático:
// nadie espera en vivo, y la mayoría de sus candidatos ya vienen resueltos
// del caché que dejó usuarios.html, así que casi nunca llega a necesitar
// siquiera el primer piso.
//
// SIEMPRE responde algo — nunca deja al front colgado ni le devuelve un
// error que rompa el flujo. Si Anthropic tarda más de ANTHROPIC_TIMEOUT_MS,
// falla, o la respuesta no es interpretable, responde { genero: null } —
// el front lo trata como "insegura" (deja pasar la canción con la alarma
// para el DJ, nunca bloquea por una falla del servicio).
// ========================================
const ANTHROPIC_TIMEOUT_MS = 4000;

function construirPromptGenero(titulo, artista, listaGeneros) {
  return `Cancion: "${titulo}"${artista ? ` — Artista/canal: "${artista}"` : ""}

Generos permitidos hoy: ${listaGeneros}

Responde EXCLUSIVAMENTE con el id exacto de UNO de los generos permitidos de la lista de arriba si la cancion pertenece claramente a ese genero — aqui si reconoces la cancion o el artista, aunque sea parcialmente o por un nombre de canal poco claro, responde con tu mejor clasificacion en vez de dudar.

NO_COINCIDE es una decision seria: bloquea a un cliente real de un bar en el momento en que esta pidiendo su cancion. Uselo UNICAMENTE cuando esta SEGURO de cual es el genero real de la cancion Y ese genero claramente no es ninguno de los permitidos (ej: reconoce que es reggaeton y reggaeton no esta en la lista). Si el artista le resulta poco conocido, no esta seguro de su genero exacto, o solo tiene una sospecha sin certeza real, NO use NO_COINCIDE — responda INSEGURO en su lugar. Ante cualquier duda genuina sobre el genero real de la cancion, la respuesta correcta es INSEGURO, nunca NO_COINCIDE.

No agregues explicaciones ni texto adicional — responde solo esa palabra, nada mas.`;
}

// Una sola llamada a Anthropic con el modelo indicado. Devuelve el texto
// crudo de la respuesta (ya recortado), o null si algo falló.
// viaProxy:false — esta llamada no es a YouTube, no debe pasar por
// QuotaGuard (evita gastar ancho de banda del plan en algo que no lo
// necesita).
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

app.post("/genero", async (req, res) => {
  const { titulo, artista, generos, segundaOpinion } = req.body || {};

  if (!titulo || !Array.isArray(generos) || generos.length === 0) {
    return res.status(400).json({ error: "Faltan datos (titulo, generos)" });
  }

  console.log(`🎵 /genero: "${titulo}" — "${artista || "?"}" | permitidos: ${generos.join(",")} | segundaOpinion=${!!segundaOpinion}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️ ANTHROPIC_API_KEY no configurada — /genero responde sin verificar");
    return res.json({ genero: null });
  }

  const listaGeneros = generos.join(", ");
  const prompt = construirPromptGenero(titulo, artista, listaGeneros);

  try {
    // ── Piso 1: Haiku (siempre) ──
    let texto = await preguntarleAClaude(prompt, "claude-haiku-4-5-20251001");
    if (texto === null) return res.json({ genero: null }); // falló Anthropic → insegura, nunca bloquea

    console.log(`🎵 /genero: "${titulo}" → Haiku respondió "${texto}"`);

    // ── Piso 2: Sonnet, SOLO si Haiku va a BLOQUEAR y el llamador lo pidió ──
    // 🩹 (ago-2026 fix) Antes esta condición EXCLUÍA "NO_COINCIDE" a propósito
    // por error — dejaba pasar a Sonnet solo las respuestas raras/inseguras,
    // pero un NO_COINCIDE directo de Haiku (el caso real: no reconoció a Viti
    // Ruiz y bloqueó "Magia Rosa", que sí era salsa permitida) nunca llegaba
    // a pedir el arbitraje. Ahora cualquier resultado que vaya a terminar en
    // bloqueo pasa por Sonnet antes de decidir — es exactamente para ESO que
    // se pidió la segunda opinión.
    const haikuBloquearia = texto === "NO_COINCIDE" || !generos.includes(texto);
    if (haikuBloquearia && segundaOpinion === true) {
      const textoSonnet = await preguntarleAClaude(prompt, "claude-sonnet-5");
      if (textoSonnet !== null) {
        console.log(`🎵 /genero: "${titulo}" → segunda opinión Sonnet respondió "${textoSonnet}"`);
        texto = textoSonnet; // Sonnet manda la decisión final
      }
      // Si Sonnet falla, se sigue con lo que ya dijo Haiku — nunca se deja al
      // front sin respuesta por culpa del segundo piso.
    }

    if (texto === "NO_COINCIDE") return res.json({ genero: "NO_COINCIDE" });
    if (!generos.includes(texto)) {
      if (texto !== "INSEGURO") console.warn(`⚠️ /genero: respuesta inesperada ("${texto}"), tratando como insegura`);
      return res.json({ genero: null }); // INSEGURO o respuesta rara → tratar como insegura
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
