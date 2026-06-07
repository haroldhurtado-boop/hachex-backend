const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// GET /search?q=nombre+artista
// Busca en YouTube y devuelve resultados
// ========================================

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Falta el parámetro q" });

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });

    const html = await response.text();

    // Extraer ytInitialData del HTML de YouTube
    const match = html.match(/var ytInitialData = ({.*?});/s);
    if (!match) return res.status(500).json({ error: "No se pudo parsear YouTube" });

    const data = JSON.parse(match[1]);

    // Navegar al array de resultados
    const contents =
      data?.contents
          ?.twoColumnSearchResultsRenderer
          ?.primaryContents
          ?.sectionListRenderer
          ?.contents?.[0]
          ?.itemSectionRenderer
          ?.contents || [];

    // Filtrar solo videos (no playlists, no canales)
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
// GET /health — verificar que el server vive
// ========================================

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Hache X Backend" });
});

app.listen(PORT, () => {
  console.log(`✅ Hache X Backend corriendo en puerto ${PORT}`);
});

// ========================================
// GET /duration?videoId=XXX
// Obtiene la duración de un video en segundos
// ========================================
app.get("/duration", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Falta videoId" });

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const html = await response.text();

    // Buscar duración en el HTML
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    if (!match) return res.status(404).json({ error: "No se encontró duración" });

    res.json({ duration: parseInt(match[1]) });
  } catch(e) {
    console.error("Error /duration:", e);
    res.status(500).json({ error: "Error interno" });
  }
});
