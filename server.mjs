import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TikTokLiveClient, EventType, GiftStreakTracker } from "piratetok-live-js";

const PORT = Number(process.env.PORT || 10000);
const USER = (process.env.TIKTOK_USERNAME || "arya.1027").replace(/^@/, "");
const clients = new Set();
const teamsByUser = new Map();
const seenGifts = new Map();
const giftStreaks = new GiftStreakTracker();

let giftMap = {};
try { giftMap = JSON.parse(process.env.GIFT_MAP_JSON || "{}"); }
catch { console.error("[config] GIFT_MAP_JSON geçersiz; boş eşleştirme."); }

let status = "starting";
let liveClient = null;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("content-type", "application/json; charset=utf-8");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, status, tiktokUsername: USER,
      mappedGiftCount: Object.keys(giftMap).length,
      observedGiftCount: seenGifts.size,
      connector: "piratetok-live-js"
    }));
  }
  if (url.pathname === "/api/gifts") {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, status, gifts: [...seenGifts.values()] }));
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocketServer({ server, path: "/events" });
wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "status", status, tiktokUsername: USER }));
  ws.on("close", () => clients.delete(ws));
});

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}
function setStatus(value, detail = "") {
  status = value;
  console.log("[status]", value, detail);
  broadcast({ type: "status", status, detail });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connectLoop() {
  while (true) {
    try {
      setStatus("connecting", `@${USER} yayınına bağlanılıyor`);
      const client = new TikTokLiveClient(USER).maxRetries(10).staleTimeout(90000);
      liveClient = client;

      client.on(EventType.chat, data => {
        const username = data?.user?.uniqueId || data?.user?.unique_id;
        const comment = String(data?.content || "").trim();
        const match = comment.match(/^!tak[iı]m\s+(GS|FB|BJK|AMED|TS)$/i);
        if (!username || !match) return;
        const team = match[1].toUpperCase();
        teamsByUser.set(username.toLowerCase(), team);
        broadcast({ type: "team", username, team });
        console.log("[team]", username, team);
      });

      client.on(EventType.gift, data => {
        const gift = data?.gift || {};
        const username = data?.user?.uniqueId || data?.user?.unique_id || "unknown";
        const giftId = String(gift.id ?? gift.giftId ?? data?.giftId ?? "");
        const giftName = gift.name || data?.giftName || "TikTok hediyesi";
        const diamonds = Number(gift.diamondCount ?? gift.diamond_count ?? data?.diamondCount ?? 0);
        const repeatCount = Math.max(1, Number(data?.repeatCount || 1));

        // Save every observed gift to help build the gift-ID mapping.
        if (giftId) seenGifts.set(giftId, {
          giftId, name: giftName, diamondCount: diamonds,
          lastSeenAt: new Date().toISOString()
        });

        const streak = giftStreaks.process(data);
        if (streak && streak.isFinal === false) return;

        const mapped = giftMap[giftId] || null;
        const chatTeam = teamsByUser.get(username.toLowerCase()) || null;
        const totalDiamonds = Number(streak?.totalDiamondCount ?? diamonds * repeatCount);
        const pointsPerGift = Number(mapped?.points ?? diamonds);
        const event = {
          type: "gift",
          username,
          nickname: data?.user?.nickname || username,
          giftId,
          giftName,
          diamonds,
          repeatCount,
          totalDiamonds,
          team: mapped?.team || chatTeam,
          points: mapped ? pointsPerGift * repeatCount : null,
          mapped: Boolean(mapped),
          source: mapped ? "giftId" : (chatTeam ? "chat-command" : "unassigned")
        };
        console.log("[gift]", JSON.stringify(event));
        broadcast(event);
      });

      client.on(EventType.connected, data => {
        setStatus("connected", `TikTok LIVE bağlantısı kuruldu (oda: ${data?.roomId || "bilinmiyor"})`);
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
      // Keep process alive; library manages the reconnect loop.
      while (liveClient === client) await wait(3000);
    } catch (err) {
      console.error("[connect]", err?.message || err);
      setStatus("waiting", err?.message || "Yayın bekleniyor veya bağlantı kurulamadı");
    }
    try { liveClient?.disconnect(); } catch {}
    liveClient = null;
    await wait(15000);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("Taraftar Arenası PirateTok bridge listening on", PORT);
  connectLoop();
});
