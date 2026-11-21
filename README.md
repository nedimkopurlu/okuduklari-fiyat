# okuduklari-fiyat
okuduklari.com kitap sayfalarındaki fiyat karşılaştırması için saat başı güncellenen fiyat verisi.
`veri/<ISBN'in son iki hanesi>.json` → `{ "<isbn>": { "t": ms, "teklifler": [{ "m", "fiyat", "url", "stok" }] } }`.
Yalnız mağazaların herkese açık ürün sayfaları okunur; bot koruması olan mağazalar sorulmaz.
