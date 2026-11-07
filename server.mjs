import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TikTokLiveClient, EventType, GiftStreakTracker } from "piratetok-live-js";

const PORT = Number(process.env.PORT || 10000);
const USER = (process.env.TIKTOK_USERNAME || "arya.1027").replace(/^@/, "");
const sockets = new Set();
const observed = new Map();
let status = "starting";
let liveClient;

function norm(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ").trim();
}
const DEFAULT_GIFT_MAP = {
  "Pati": {
    "team": "ts",
    "points": 1
  },
  "Bal kabağı": {
    "team": "fb",
    "points": 1
  },
  "Göz kırpma": {
    "team": "gs",
    "points": 1
  },
  "Mate melodisi": {
    "team": "bjk",
    "points": 1
  },
  "TikTok": {
    "team": "amed",
    "points": 1
  },
  "Gördüğümü beğendim": {
    "team": "gs",
    "points": 10
  },
  "Ağır çekim": {
    "team": "ts",
    "points": 10
  },
  "Dostluk kolyesi": {
    "team": "fb",
    "points": 10
  },
  "Rosa": {
    "team": "bjk",
    "points": 10
  },
  "Kalp": {
    "team": "amed",
    "points": 10
  },
  "Elle kalp": {
    "team": "ts",
    "points": 100
  },
  "Mishka bear": {
    "team": "gs",
    "points": 100
  },
  "Buket": {
    "team": "fb",
    "points": 100
  },
  "Oyun kumandası": {
    "team": "bjk",
    "points": 100
  },
  "Balon hediye kutusu": {
    "team": "amed",
    "points": 100
  },
  "Para tabancası": {
    "team": "gs",
    "points": 500
  },
  "Harikasın": {
    "team": "ts",
    "points": 500
  },
  "Aslan yelesi": {
    "team": "fb",
    "points": 500
  },
  "Bal telleri": {
    "team": "bjk",
    "points": 500
  },
  "Prince": {
    "team": "amed",
    "points": 500
  }
};

function loadMap() {
  try {
    // Built-in mapping is ready to use; optional Render env JSON can override entries.
    const overrides = JSON.parse(process.env.GIFT_MAP_JSON || "{}");
    const raw = { ...DEFAULT_GIFT_MAP, ...overrides };
    const out = new Map();
    for (const [name, value] of Object.entries(raw)) {
      if (value && value.team) out.set(norm(name), {
        team: String(value.team).toLowerCase(),
        points: Number(value.points || 0)
      });
    }
    return out;
  } catch (e) {
    console.error("[config] GIFT_MAP_JSON geçersiz:", e.message);
    return new Map();
  }
}
const giftMap = loadMap();

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, status, tiktokUsername: USER,
      mappedGiftCount: giftMap.size, observedGiftCount: observed.size,
      matching: "gift-name", connector: "piratetok-live-js"
    }));
  }
  if (url.pathname === "/api/gifts") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, status, gifts: [...observed.values()],
      mappings: [...giftMap.entries()].map(([name, v]) => ({ name, ...v }))
    }));
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocketServer({ server, path: "/events" });
wss.on("connection", ws => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: "status", status, tiktokUsername: USER }));
  ws.on("close", () => sockets.delete(ws));
});
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function setStatus(next, detail = "") {
  status = next;
  console.log("[status]", next, detail);
  broadcast({ type: "status", status: next, detail });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  while (true) {
    try {
      setStatus("connecting", `@${USER} yayınına bağlanılıyor`);
      const client = new TikTokLiveClient(USER).maxRetries(10).staleTimeout(90000);
      liveClient = client;
      const tracker = new GiftStreakTracker();

      client.on(EventType.gift, data => {
        try {
          const gift = data?.gift || {};
          const giftName = String(gift.name || data?.giftName || "Bilinmeyen hediye");
          const diamonds = Number(gift.diamondCount ?? gift.diamond_count ?? data?.diamondCount ?? 0);
          const repeatCount = Math.max(1, Number(data?.repeatCount || 1));
          const user = data?.user || {};
          const username = user.uniqueId || user.unique_id || "unknown";
          const nickname = user.nickname || username;

          const key = norm(giftName);
          const old = observed.get(key) || { name: giftName, diamondCount: diamonds, seenCount: 0 };
          old.diamondCount = diamonds;
          old.seenCount += 1;
          old.lastSeenAt = new Date().toISOString();
          observed.set(key, old);

          let streak = null;
          try { streak = tracker.process(data); } catch (e) {
            console.warn("[gift tracker]", e.message);
          }
          // Combo hediyelerde yalnızca seri tamamlandığında tek olay üret.
          if (streak && streak.isFinal === false) return;

          const mapped = giftMap.get(key);
          const count = Math.max(1, Number(streak?.eventGiftCount ?? repeatCount));
          const pointsPerGift = mapped?.points > 0 ? mapped.points : diamonds;
          const event = {
            type: "gift", username, nickname, giftName, diamonds,
            repeatCount: count,
            totalDiamonds: Number(streak?.totalDiamondCount ?? diamonds * count),
            team: mapped?.team || null,
            points: mapped ? pointsPerGift * count : 0,
            mapped: Boolean(mapped),
            source: "gift-name"
          };
          console.log("[gift]", JSON.stringify(event));
          broadcast(event);
        } catch (e) {
          console.error("[gift handler]", e);
        }
      });

      client.on(EventType.connected, data => {
        setStatus("connected", `TikTok LIVE bağlantısı kuruldu${data?.roomId ? ` (oda: ${data.roomId})` : ""}`);
      });
      client.on(EventType.disconnected, data => setStatus("disconnected", data?.reason || ""));
      client.on(EventType.reconnecting, data => setStatus("reconnecting", JSON.stringify(data || {})));
      client.on(EventType.error, err => {
        const message = err?.message || String(err);
        console.error("[TikTok]", message);
        setStatus("error", message);
      });

      await client.connect();
      setStatus("connected", "TikTok LIVE bağlantısı kuruldu");
      while (liveClient === client) await sleep(3000);
    } catch (err) {
      console.error("[connect]", err?.message || err);
      setStatus("waiting", err?.message || "Yayın bekleniyor veya bağlantı kurulamadı");
    }
    try { liveClient?.disconnect(); } catch {}
    liveClient = null;
    await sleep(12000);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Taraftar Arenası gift bridge :${PORT} — @${USER}`);
  console.log(`[config] ${giftMap.size} hediye adı eşleştirmesi yüklendi`);
  run();
});
