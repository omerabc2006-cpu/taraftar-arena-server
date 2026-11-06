# Taraftar Arenası – TikTok LIVE köprüsü

Render Web Service ayarları:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable: `TIKTOK_USERNAME` = `arya.1027`
- Node: 20 veya üzeri

Deploy sonrası sağlık kontrolü: `https://SERVIS-ADIN.onrender.com/`
WebSocket: `wss://SERVIS-ADIN.onrender.com/events`

İzleyici takımını sohbete `!takim GS`, `!takim FB`, `!takim BJK`, `!takim AMED` veya `!takim TS` yazarak seçer. Sonraki hediyeleri o takıma eşlenir.

ÖNEMLİ:
- Bu resmî TikTok API'si değildir; TikTok'un herkese açık LIVE akışını okuyan üçüncü taraf açık kaynak pakettir. Kesinti veya protokol değişikliği olabilir.
- Yalnızca yayın canlı ve herkese açıkken olay alınabilir.
- Bu sunucu olayları yayınlar. Netlify uygulamasına bağlayıp puan ekleme entegrasyonu ayrıca yapılmalıdır.
- TikTok şifresi, oturum çerezi veya doğrulama kodu gerekmez. Paylaşmayın.
