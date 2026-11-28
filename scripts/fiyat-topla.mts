/**
 * Saat başı fiyat toplama (editör, 7 Kasım; docs/v3/FIYAT-KARSILASTIRMA.md). İş akışı: .github/workflows/fiyat.yml
 *
 *   npx tsx scripts/fiyat-topla.mts [--n 400] [--sinir 20] [--cikti fiyat-veri] [--onceki-d1 onceki.json] [--sql fiyat.sql]
 *
 * Kitaplar: content/books.json'dan (yayında, kapaklı, isbn13'lü) okur sayısına göre ilk N. Her saat en popüler 150 +
 * kalanların üçte biri (saat % 3 dilimi) sorulur: tüm N ~3 saatte bir tazelenir. Mağaza başına en çok 1 istek/sn
 * (fiyat-dene.mts sira()), aynı anda en çok FIYAT_ES kitap, FIYAT_SURE dakikada (varsayılan 35) yeni kitap başlatılmaz.
 *
 * Çıktı: <cikti>/00.json … 99.json (ISBN'in son 2 hanesi): { "<isbn>": { t, teklifler: [{ m, fiyat, url, stok, g }] } }
 * Yalnız stokta olanlar, fiyata göre. g = teklifin son görüldüğü an. Önceki veriyle birleşir: bu çalışmada bulunamayan
 * (yok/engelli/hata) mağazanın eski teklifi 24 saatten eski değilse kalır; "stok yok" diyen mağazanınki hemen düşer.
 * --sql: D1 için toplu UPSERT dosyası (cloudflare/d1/fiyat.sql tablosu). --onceki-d1: `wrangler d1 execute --json` çıktısı.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fiyatlar, type Sonuc } from './fiyat-dene.mts';

type Teklif = { m: string; fiyat: number; url: string; stok: true; g: number };
type Kayit = { t: number; teklifler: Teklif[] };
type Veri = Record<string, Kayit>;

const arg = (ad: string, vars?: string) => { const i = process.argv.indexOf(`--${ad}`); return i > 0 ? process.argv[i + 1] : vars; };
const N = Number(arg('n', process.env.FIYAT_N ?? '400'));
const SINIR = arg('sinir') ? Number(arg('sinir')) : null; // yerel deneme: yalnız ilk k kitap
const CIKTI = arg('cikti', process.env.FIYAT_CIKTI ?? 'fiyat-veri')!;
const ES = Number(process.env.FIYAT_ES ?? 8);
const SURE = Number(process.env.FIYAT_SURE ?? 35) * 60_000;
const GUN = 24 * 3600_000;
const SICAK = 150;

// ── Kitap seçimi ──────────────────────────────────────────────────────────────
const kok = fileURLToPath(new URL('..', import.meta.url));
type Aday = { isbn: string; ip: { baslik?: string; yazar?: string; yayinevi?: string }; n: number };
let aday: Aday[];
const KAYNAK = process.env.FIYAT_KITAPLAR; // herkese açık fiyat deposunda: https://okuduklari.com/fiyat-kitaplar.json (sıralı)
if (KAYNAK) {
  const ham = /^https?:/.test(KAYNAK) ? await (await fetch(KAYNAK)).json() : JSON.parse(readFileSync(KAYNAK, 'utf8'));
  aday = (ham as Array<{ i: string; b: string; y: string; p?: string }>).filter((k) => /^97[89]\d{10}$/.test(k.i)).slice(0, N).map((k, j) => ({ isbn: k.i, ip: { baslik: k.b, yazar: k.y, yayinevi: k.p }, n: N - j }));
} else {
  const kitaplar = JSON.parse(readFileSync(join(kok, 'content/books.json'), 'utf8')) as Array<Record<string, any>>;
  const listeler = JSON.parse(readFileSync(join(kok, 'content/lists.json'), 'utf8')) as Array<{ celebrityId: string; bookIds?: string[] }>;
  const okur = new Map<string, Set<string>>();
  for (const l of listeler) for (const b of l.bookIds ?? []) (okur.get(b) ?? okur.set(b, new Set()).get(b)!).add(l.celebrityId);
  aday = kitaplar
    .filter((k) => /^97[89]\d{10}$/.test(String(k.isbn13 ?? '')) && k.coverImageUrl)
    .map((k) => ({ isbn: String(k.isbn13), ip: { baslik: k.title, yazar: k.author, yayinevi: k.publisher }, n: okur.get(k.id)?.size ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .filter((k, i, a) => a.findIndex((x) => x.isbn === k.isbn) === i)
    .slice(0, N);
}
const saat = Math.floor(Date.now() / 3600_000);
let secilen = [...aday.slice(0, SICAK), ...aday.slice(SICAK).filter((_, i) => i % 3 === saat % 3)];
if (SINIR) secilen = secilen.slice(0, SINIR);

// ── Önceki veri ───────────────────────────────────────────────────────────────
const parca = (isbn: string) => isbn.slice(-2);
const veri: Veri = {};
mkdirSync(CIKTI, { recursive: true });
for (let i = 0; i < 100; i++) {
  const f = join(CIKTI, `${String(i).padStart(2, '0')}.json`);
  if (existsSync(f)) try { Object.assign(veri, JSON.parse(readFileSync(f, 'utf8'))); } catch { /* bozuk parça: yeniden yazılır */ }
}
const d1Dosya = arg('onceki-d1');
const d1Onceki = new Set<string>();
if (d1Dosya && existsSync(d1Dosya)) {
  // wrangler d1 execute --json: [{ results: [{ isbn, veri, t }], ... }]
  const j = JSON.parse(readFileSync(d1Dosya, 'utf8'));
  for (const r of ([] as any[]).concat(j).flatMap((x) => x?.results ?? [])) {
    d1Onceki.add(String(r.isbn));
    try { veri[r.isbn] = { t: Number(r.t), teklifler: JSON.parse(r.veri) }; } catch { /* geç */ }
  }
}

// ── Amazon (yer hazır) ────────────────────────────────────────────────────────
// Amazon Ortakları ürün API'si (PA-API 5) 3 satıştan sonra açılır; anahtarlar AMAZON_ERISIM/AMAZON_GIZLI sırlarıyla gelince
// burada GetItems (ItemIds = ISBN, PartnerTag okuduklari-21) çağrılır ve { m: 'amazon', … } teklifi eklenir. Şimdilik istek yok.
async function amazonTeklif(_isbn: string): Promise<Teklif | null> {
  if (!process.env.AMAZON_ERISIM || !process.env.AMAZON_GIZLI) return null;
  return null; // TODO(PA-API açılınca): imzalı GetItems isteği
}

// ── Toplama ───────────────────────────────────────────────────────────────────
const t0 = Date.now();
const sayac = { kitap: 0, teklif: 0, engelli: 0, hata: 0, atlanan: 0 };
const engelliMagaza = new Map<string, number>();
const durdur = new Set<string>(); // 3 engelden sonra mağaza bu çalışmada hiç sorulmaz (koruma aşılmaz, zorlanmaz)

function birlestir(isbn: string, sonuc: Sonuc[], amz: Teklif | null) {
  const simdi = Date.now();
  const eski = new Map((veri[isbn]?.teklifler ?? []).map((x) => [x.m, x]));
  const yeni: Teklif[] = [];
  for (const s of sonuc) {
    if (s.durum === 'bulundu') {
      if (s.teklif.stokta !== false) yeni.push({ m: s.magaza, fiyat: Math.round(s.teklif.fiyat * 100) / 100, url: s.teklif.adres, stok: true, g: simdi });
      continue; // stok yok: eski teklif düşer
    }
    if (s.durum === 'engelli') { sayac.engelli++; const n = (engelliMagaza.get(s.magaza) ?? 0) + (s.ms ? 1 : 0); engelliMagaza.set(s.magaza, n); if (n >= 3) durdur.add(s.magaza); }
    if (s.durum === 'hata') sayac.hata++;
    const e = eski.get(s.magaza);
    if (e && s.durum !== 'atlandi' && simdi - (e.g ?? 0) < GUN) yeni.push(e);
  }
  if (amz) yeni.push(amz);
  sayac.teklif += yeni.length;
  if (yeni.length) veri[isbn] = { t: simdi, teklifler: yeni.sort((a, b) => a.fiyat - b.fiyat) };
  else delete veri[isbn];
}

let sira = 0;
await Promise.all(Array.from({ length: ES }, async () => {
  while (sira < secilen.length) {
    if (Date.now() - t0 > SURE) { sayac.atlanan = secilen.length - sira; sira = secilen.length; break; }
    const k = secilen[sira++];
    const [sonuc, amz] = await Promise.all([fiyatlar(k.isbn, k.ip, { tum: true, engelli: durdur }), amazonTeklif(k.isbn)]);
    birlestir(k.isbn, sonuc, amz);
    sayac.kitap++;
    if (process.env.FIYAT_IZ) console.error(k.isbn, k.ip.baslik, sonuc.map((s) => `${s.magaza}:${s.durum === 'bulundu' ? s.teklif.fiyat : s.durum}`).join(' '));
  }
}));

// Sorulmayan kitaplarda da 24 saati geçen teklifler düşer (N'den çıkan kitap kendiliğinden temizlenir).
const simdi = Date.now();
for (const [isbn, k] of Object.entries(veri)) {
  k.teklifler = k.teklifler.filter((x) => simdi - (x.g ?? k.t) < GUN);
  if (!k.teklifler.length) delete veri[isbn];
}

// ── Yazma ─────────────────────────────────────────────────────────────────────
const parcalar: Record<string, Veri> = {};
for (let i = 0; i < 100; i++) parcalar[String(i).padStart(2, '0')] = {};
for (const isbn of Object.keys(veri).sort()) parcalar[parca(isbn)][isbn] = veri[isbn];
for (const [p, v] of Object.entries(parcalar)) writeFileSync(join(CIKTI, `${p}.json`), JSON.stringify(v));

const sqlDosya = arg('sql');
if (sqlDosya) {
  const s = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const satir = Object.entries(veri).map(([isbn, k]) => `INSERT INTO fiyat (isbn, veri, t) VALUES (${s(isbn)}, ${s(JSON.stringify(k.teklifler))}, ${k.t}) ON CONFLICT(isbn) DO UPDATE SET veri = excluded.veri, t = excluded.t;`);
  const silinen = [...d1Onceki].filter((i) => !veri[i]);
  if (silinen.length) satir.push(`DELETE FROM fiyat WHERE isbn IN (${silinen.map(s).join(', ')});`);
  writeFileSync(sqlDosya, satir.join('\n') + '\n');
}

console.log(JSON.stringify({
  sure_sn: Math.round((Date.now() - t0) / 1000), aday: aday.length, sorulan: secilen.length, ...sayac,
  kayitli_kitap: Object.keys(veri).length, engelli_magaza: Object.fromEntries(engelliMagaza),
}));
