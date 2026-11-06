import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 10000);
const USER = (process.env.TIKTOK_USERNAME || "arya.1027").replace(/^@/, "");
const clients = new Set();
const teamsByUser = new Map();
let status = "starting";
let live = null;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, status, tiktokUsername: USER }));
});
const wss = new WebSocketServer({ server: httpServer, path: "/events" });

wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "status", status, tiktokUsername: USER }));
  ws.on("close", () => clients.delete(ws));
});

function send(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function setStatus(value, detail = "") {
  status = value;
  console.log("[status]", value, detail);
  send({ type: "status", status: value, detail });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  for (;;) {
    try {
      setStatus("connecting", `@${USER} yayını bekleniyor`);
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
        if (data?.giftType === 1 && data?.repeatEnd === false) return;
        const username = data?.user?.uniqueId || "unknown";
        const diamonds = Number(
          data?.giftDetails?.diamondCount ??
          data?.extendedGiftInfo?.diamond_count ??
          data?.gift?.diamond_count ??
          data?.diamondCount ?? 0
        );
        const repeatCount = Math.max(1, Number(data?.repeatCount || 1));
        const event = {
          type: "gift",
          username,
          nickname: data?.user?.nickname || username,
          team: teamsByUser.get(username.toLowerCase()) || null,
          giftName: data?.giftDetails?.giftName || data?.extendedGiftInfo?.name || data?.gift?.name || "TikTok hediyesi",
          diamonds,
          repeatCount,
          totalDiamonds: diamonds * repeatCount
        };
        console.log("[gift]", event);
        send(event);
      });

      live.on("connected", () => setStatus("connected", "TikTok LIVE bağlantısı kuruldu"));
      live.on("disconnected", info => setStatus("disconnected", info?.reason || ""));
      live.on("error", err => {
        console.error("[TikTok]", err?.message || err);
        setStatus("error", err?.message || "Bağlantı hatası");
      });

      await live.connect();
      setStatus("connected", "TikTok LIVE bağlantısı kuruldu");
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Taraftar Arenasi bridge listening on", PORT);
  run();
});
