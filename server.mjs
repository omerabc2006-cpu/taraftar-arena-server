import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 10000);
const USER = (process.env.TIKTOK_USERNAME || "arya.1027").replace(/^@/, "");
const clients = new Set();
const teamsByUser = new Map();

// Gift IDs are intentionally left empty until the live gift catalog is read.
// Configure Render env var GIFT_MAP_JSON like:
// {"5655":{"team":"gs","points":1},"1234":{"team":"fb","points":10}}
let giftMap = {};
try {
  giftMap = JSON.parse(process.env.GIFT_MAP_JSON || "{}");
} catch {
  console.error("[config] GIFT_MAP_JSON geçerli JSON değil; boş eşleştirme kullanılacak.");
}

let status = "starting";
let live = null;
let lastCatalog = [];

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" || url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      status,
      tiktokUsername: USER,
      mappedGiftCount: Object.keys(giftMap).length
    }));
  }

  if (url.pathname === "/api/gifts") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      status,
      gifts: lastCatalog
    }));
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocketServer({ server, path: "/events" });

wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "status", status, tiktokUsername: USER }));
  ws.on("close", () => clients.delete(ws));
});

function send(data) {
  const message = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function setStatus(value, detail = "") {
  status = value;
  console.log("[status]", value, detail);
  send({ type: "status", status: value, detail });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeCatalog(items) {
  if (!Array.isArray(items)) return [];
  return items.map(g => ({
    giftId: String(g?.id ?? g?.giftId ?? g?.gift_id ?? ""),
    name: g?.name ?? g?.giftName ?? g?.gift_name ?? "Bilinmeyen hediye",
    diamondCount: Number(g?.diamond_count ?? g?.diamondCount ?? g?.diamondCount ?? 0),
    imageUrl: g?.image?.url_list?.[0] ?? g?.image?.urlList?.[0] ?? g?.imageUrl ?? null
  })).filter(g => g.giftId);
}

async function refreshCatalog(connection) {
  try {
    if (Array.isArray(connection.availableGifts)) {
      lastCatalog = normalizeCatalog(connection.availableGifts);
    }
    if (!lastCatalog.length && typeof connection.fetchAvailableGifts === "function") {
      const raw = await connection.fetchAvailableGifts();
      lastCatalog = normalizeCatalog(raw?.gifts ?? raw);
    }
    console.log(`[catalog] ${lastCatalog.length} hediye kataloğa alındı`);
    send({ type: "catalog", count: lastCatalog.length });
  } catch (error) {
    console.error("[catalog]", error?.message || error);
  }
}

async function run() {
  for (;;) {
    try {
      setStatus("connecting", `@${USER} yayınına bağlanılıyor`);
      live = new TikTokLiveConnection(USER, {
        enableExtendedGiftInfo: true,
        processInitialData: false
      });

      live.on(WebcastEvent.CHAT, data => {
        const username = data?.user?.uniqueId;
        const comment = String(data?.comment || "").trim();
        const match = comment.match(/^!tak[iı]m\s+(GS|FB|BJK|AMED|TS)$/i);
        if (!username || !match) return;

        const team = match[1].toUpperCase();
        teamsByUser.set(username.toLowerCase(), team);
        send({ type: "team", username, team });
        console.log("[team]", username, team);
      });

      live.on(WebcastEvent.GIFT, data => {
        // Streak gifts are cumulative while being sent. Count only the final frame.
        if (Number(data?.giftType) === 1 && data?.repeatEnd !== true) return;

        const username = data?.user?.uniqueId || "unknown";
        const giftId = String(data?.giftId ?? data?.gift?.gift_id ?? "");
        const giftName =
          data?.giftDetails?.giftName ||
          data?.extendedGiftInfo?.name ||
          data?.giftName ||
          data?.describe ||
          "TikTok hediyesi";

        const diamonds = Number(
          data?.diamondCount ??
          data?.giftDetails?.diamondCount ??
          data?.extendedGiftInfo?.diamond_count ??
          data?.gift?.diamond_count ?? 0
        );
        const repeatCount = Math.max(1, Number(data?.repeatCount || 1));
        const mapped = giftMap[giftId] || null;
        const chatTeam = teamsByUser.get(username.toLowerCase()) || null;

        const event = {
          type: "gift",
          username,
          nickname: data?.user?.nickname || username,
          giftId,
          giftName,
          diamonds,
          repeatCount,
          totalDiamonds: diamonds * repeatCount,
          team: mapped?.team || chatTeam,
          points: mapped
            ? Number(mapped.points ?? diamonds) * repeatCount
            : null,
          mapped: Boolean(mapped),
          source: mapped ? "giftId" : (chatTeam ? "chat-command" : "unassigned")
        };

        console.log("[gift]", JSON.stringify(event));
        send(event);
      });

      live.on("connected", async () => {
        setStatus("connected", "TikTok LIVE bağlantısı kuruldu");
        await refreshCatalog(live);
      });
      live.on("disconnected", info => setStatus("disconnected", info?.reason || ""));
      live.on("error", err => {
        console.error("[TikTok]", err?.message || err);
        setStatus("error", err?.message || "Bağlantı hatası");
      });

      await live.connect();
      setStatus("connected", "TikTok LIVE bağlantısı kuruldu");
      await refreshCatalog(live);
      while (live?.isConnected) await wait(3000);
    } catch (err) {
      console.error("[connect]", err?.message || err);
      setStatus("waiting", err?.message || "Yayın bekleniyor veya bağlantı kurulamadı");
    }

    try { await live?.disconnect(); } catch {}
    live = null;
    await wait(15000);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("Taraftar Arenası gift bridge listening on", PORT);
  run();
});
