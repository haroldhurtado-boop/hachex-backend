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
    const response  = await fetch(searchUrl, { headers: HEADERS });
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
// GET /audio?videoId=XXX
// Extrae URL directa del audio desde YouTube
// sin yt-dlp, usando ytInitialPlayerResponse
// ========================================
app.get("/audio", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });

  try {
    // Método 1: innertube API (más estable)
    const innertubeRes = await fetch("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
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
    const pageRes  = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: HEADERS });
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
    const response = await fetch(url, { headers: HEADERS });
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

app.listen(PORT, () => {
  console.log(`✅ Hache X Backend corriendo en puerto ${PORT}`);
});
