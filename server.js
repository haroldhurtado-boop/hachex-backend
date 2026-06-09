const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// GET /search?q=nombre+artista
// ========================================

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Falta el parámetro q" });

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response  = await fetch(searchUrl, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });
    const html  = await response.text();
    const match = html.match(/var ytInitialData = ({.*?});/s);
    if (!match) return res.status(500).json({ error: "No se pudo parsear YouTube" });

    const data     = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

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
// GET /duration?videoId=XXX
// Obtiene la duración en segundos
// ========================================

app.get("/duration", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });

  try {
    const url      = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });
    const html = await response.text();

    // Intentar múltiples patrones
    const patterns = [
      /"lengthSeconds":"(\d+)"/,
      /"lengthSeconds":(\d+)/,
      /lengthSeconds\\?":\\?"(\d+)/,
      /"duration":(\d+)/
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const duration = parseInt(match[1]);
        if (duration > 0) {
          console.log(`✅ Duración encontrada: ${duration}s para ${videoId}`);
          return res.json({ duration });
        }
      }
    }

    // Intentar via ytInitialPlayerResponse
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s);
    if (playerMatch) {
      try {
        const playerData = JSON.parse(playerMatch[1]);
        const dur = playerData?.videoDetails?.lengthSeconds;
        if (dur) {
          console.log(`✅ Duración via playerResponse: ${dur}s`);
          return res.json({ duration: parseInt(dur) });
        }
      } catch(e) {}
    }

    console.warn(`⚠️ No se encontró duración para ${videoId}`);
    res.status(404).json({ error: "No se encontró duración" });

  } catch(e) {
    console.error("Error /duration:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// ========================================
// GET /soundcloud?q=nombre+artista
// Busca en SoundCloud sin API key
// ========================================

app.get("/soundcloud", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Falta el parámetro q" });

  try {
    const searchUrl = `https://soundcloud.com/search?q=${encodeURIComponent(query)}`;
    const response  = await fetch(searchUrl, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });
    const html = await response.text();

    // Extraer hydration data de SoundCloud
    const match = html.match(/window\.__sc_hydration\s*=\s*(\[.*?\]);/s);
    if (!match) return res.status(500).json({ error: "No se pudo parsear SoundCloud" });

    const hydration = JSON.parse(match[1]);
    const collection = hydration.find(h => h.hydratable === "collection");
    if (!collection) return res.status(404).json({ tracks: [] });

    const tracks = (collection.data?.collection || [])
      .filter(item => item.kind === "track")
      .slice(0, 5)
      .map(track => ({
        trackUrl:  track.permalink_url,
        title:     track.title,
        artist:    track.user?.username || "",
        duration:  Math.floor((track.duration || 0) / 1000),
        artwork:   track.artwork_url || ""
      }));

    res.json({ tracks });
  } catch(err) {
    console.error("Error en /soundcloud:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});



app.get("/check", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });
  try {
    const url      = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    res.json({ embeddable: response.ok });
  } catch(e) {
    res.json({ embeddable: false });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Hache X Backend" });
});

app.listen(PORT, () => {
  console.log(`✅ Hache X Backend corriendo en puerto ${PORT}`);
});
