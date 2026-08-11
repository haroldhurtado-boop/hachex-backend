const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
 
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
// Helper: fetch con timeout — evita que requests colgadas se acumulen en
// memoria hasta tumbar la instancia (causa confirmada de "Ran out of memory").
// Todo fetch del servidor DEBE pasar por aquí.
// ========================================
async function fetchConTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
 
// ========================================
// GET /health
// ========================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Hache X Backend" });
});
 
// ========================================
// GET /search?q=nombre+artista
// ========================================
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Falta el parámetro q" });
 
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response  = await fetchConTimeout(searchUrl, { headers: HEADERS });
    const html      = await response.text();
    const match     = html.match(/var ytInitialData = ({.*?});/s);
    if (!match) return res.status(500).json({ error: "No se pudo parsear YouTube" });
 
    const data     = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
 
    const videos = contents
      .filter(c => c.videoRenderer)
      .slice(0, 6)
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
 
    res.json({ videos });
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
// generos: [ids permitidos hoy] }.
//
// SIEMPRE responde algo — nunca deja al front colgado ni le devuelve un
// error que rompa el flujo. Si Anthropic tarda más de ANTHROPIC_TIMEOUT_MS,
// falla, o la respuesta no es interpretable, responde { genero: null } —
// el front lo trata como "insegura" (deja pasar la canción con la alarma
// para el DJ, nunca bloquea por una falla del servicio).
// ========================================
const ANTHROPIC_TIMEOUT_MS = 4000;
 
app.post("/genero", async (req, res) => {
  const { titulo, artista, generos } = req.body || {};
 
  if (!titulo || !Array.isArray(generos) || generos.length === 0) {
    return res.status(400).json({ error: "Faltan datos (titulo, generos)" });
  }
 
  console.log(`🎵 /genero: "${titulo}" — "${artista || "?"}" | permitidos: ${generos.join(",")}`);
 
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️ ANTHROPIC_API_KEY no configurada — /genero responde sin verificar");
    return res.json({ genero: null });
  }
 
  const listaGeneros = generos.join(", ");
  const prompt = `Cancion: "${titulo}"${artista ? ` — Artista/canal: "${artista}"` : ""}
 
Generos permitidos hoy: ${listaGeneros}
 
Responde EXCLUSIVAMENTE con el id exacto de UNO de los generos permitidos de la lista de arriba si la cancion pertenece claramente a ese genero. Si la cancion NO pertenece a NINGUNO de los generos permitidos, responde exactamente: NO_COINCIDE.
 
Si reconoces la cancion o el artista, aunque sea parcialmente o por un nombre de canal poco claro, responde con tu mejor clasificacion en vez de dudar — tu conocimiento general de musica es confiable para esto. Responde INSEGURO UNICAMENTE cuando genuinamente no reconoces ni la cancion ni el artista, o el genero es realmente ambiguo entre dos generos de la lista.
 
No agregues explicaciones ni texto adicional — responde solo esa palabra, nada mas.`;
 
  try {
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
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 20,
          messages:   [{ role: "user", content: prompt }]
        })
      },
      ANTHROPIC_TIMEOUT_MS
    );
 
    if (!aiRes.ok) {
      const cuerpoError = await aiRes.text().catch(() => "(no se pudo leer el cuerpo)");
      console.error(`⚠️ /genero: Anthropic respondió status ${aiRes.status} — ${cuerpoError}`);
      return res.json({ genero: null });
    }
 
    const data  = await aiRes.json();
    const texto = (data?.content?.[0]?.text || "").trim();
 
    console.log(`🎵 /genero: "${titulo}" → Claude respondió "${texto}"`);
 
    if (texto === "NO_COINCIDE") return res.json({ genero: "NO_COINCIDE" });
    if (!generos.includes(texto)) {
      if (texto !== "INSEGURO") console.warn(`⚠️ /genero: respuesta inesperada de Claude ("${texto}"), tratando como insegura`);
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
 
