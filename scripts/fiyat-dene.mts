/**
 * Fiyat karşılaştırma PROTOTİPİ (6 Kasım, araştırma; siteye bağlı değil). Belge: docs/v3/FIYAT-KARSILASTIRMA.md
 * Verilen ISBN için erişilebilir Türk kitapçılarından fiyat çeker, en ucuz 5'i yazdırır.
 * Kod saf fetch + düzenli ifade: Cloudflare Worker'a olduğu gibi taşınabilir (Node'a özgü tek şey CLI kısmı).
 *
 *   npx tsx scripts/fiyat-dene.mts 9789750739248            tek ISBN (robots'a uyan mağazalar)
 *   npx tsx scripts/fiyat-dene.mts --deneme                 sabit 10 test ISBN'i
 *   ... --tum        robots.txt'nin arama yolunu yasakladığı mağazaları da dene (yalnız ölçüm; üretimde kapalı)
 *   ... --dogrula    bulunan fiyat ürün sayfasının görünen metninde geçiyor mu (fazladan istek)
 *   ... --json       makine okunur çıktı
 *
 * Kurallar: bot koruması (Cloudflare/Akamai sınaması, CAPTCHA, 403/511) görülürse o mağaza "engelli" döner, AŞILMAZ.
 * Ortaklık (affiliate) parametresi yok; ürün adresi mağazanın kendi temiz adresidir.
 */

export type Teklif = {
  magaza: string;
  magazaAd: string;
  fiyat: number; // TL, KDV dahil satış fiyatı
  listeFiyati: number | null;
  stokta: boolean | null;
  adres: string;
  kargo: string | null;
  baslik: string;
  kaynak: 'json-ld' | 'product-data';
  dogrulandi?: boolean | null;
};
export type Sonuc =
  | { magaza: string; durum: 'bulundu'; teklif: Teklif; ms: number }
  | { magaza: string; durum: 'yok' | 'engelli' | 'hata' | 'atlandi'; not: string; ms: number };
export type Ipucu = { baslik?: string; yazar?: string; yayinevi?: string };

type Magaza = {
  id: string;
  ad: string;
  robotsArama: boolean; // robots.txt kullandığımız yolu (User-agent: *) serbest bırakıyor mu
  yayinevi?: RegExp; // yayınevi mağazası: yalnız bu yayınevinin kitapları (katla()'lanmış ada uygulanır)
  ara: (isbn: string, ip: Ipucu) => Promise<Teklif | null>;
};

const UA =
  process.env.FIYAT_UA ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASLIK = { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9', Accept: 'text/html,application/xhtml+xml' };
const ZAMAN_ASIMI = 30000; // Dost Kitabevi arama sayfası ~2,5 MB, ~11 sn

export class Engelli extends Error {}

/** Mağaza (alan adı) başına en çok 1 istek / FIYAT_ARALIK ms (varsayılan 1000). İstekler alan adı başına sıraya girer. */
const ARALIK = Number(process.env.FIYAT_ARALIK ?? 1000);
const sonIstek = new Map<string, number>();
async function sira(u: string) {
  const h = new URL(u).hostname.replace(/^www\./, '');
  const simdi = Date.now();
  const an = Math.max(simdi, (sonIstek.get(h) ?? 0) + ARALIK);
  sonIstek.set(h, an);
  if (an > simdi) await new Promise((r) => setTimeout(r, an - simdi));
}

/** Sayfayı getirir; bot koruması işaretlerinde Engelli fırlatır (aşma denemesi yok). */
async function getir(u: string): Promise<{ html: string; url: string; status: number }> {
  await sira(u);
  const r = await fetch(u, { headers: BASLIK, redirect: 'follow', signal: AbortSignal.timeout(ZAMAN_ASIMI) });
  // Bazı mağazalar (Kitapsec, Sel) windows-1254 yayınlıyor: karakter kümesi başlıktan ya da meta'dan okunur.
  const ham = new Uint8Array(await r.arrayBuffer());
  const kume = (r.headers.get('content-type')?.match(/charset=([\w-]+)/i)?.[1] ?? new TextDecoder('latin1').decode(ham.slice(0, 3000)).match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  let html: string;
  try { html = new TextDecoder(kume).decode(ham); } catch { html = new TextDecoder('utf-8').decode(ham); }
  if (r.status === 403 || r.status === 429 || r.status === 503 || r.status === 511) throw new Engelli(`HTTP ${r.status}`);
  if (/cf-chl|challenge-platform|Attention Required! \| Cloudflare|bm-verify|_sec\/verify|captcha|The requested URL was rejected/i.test(html.slice(0, 20000)) && html.length < 60000)
    throw new Engelli('bot koruması sayfası');
  return { html, url: r.url, status: r.status };
}

const ldBloklari = (html: string): unknown[] => {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    // Bazı mağazalar açıklamaya ham satır sonu koyar (geçersiz JSON): denetim karakterleri boşluğa çevrilip yeniden denenir.
    try { out.push(JSON.parse(m[1].trim())); } catch {
      try { out.push(JSON.parse(m[1].trim().replace(/[\u0000-\u001f]+/g, ' '))); } catch { /* bozuk blok */ }
    }
  }
  return out;
};
/** JSON-LD ağacında @type'ı Product/Book olan ve gtin13/isbn'i tutan düğümü bulur. */
export function ldUrun(html: string, isbn: string): Record<string, any> | null {
  const yigin: unknown[] = ldBloklari(html);
  const eslesen: Array<Record<string, any>> = [];
  while (yigin.length) {
    const d = yigin.pop();
    if (Array.isArray(d)) { yigin.push(...d); continue; }
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, any>;
    const tur = ([] as string[]).concat(o['@type'] ?? []);
    if ((tur.includes('Product') || tur.includes('Book')) && [o.gtin13, o.isbn, o.gtin, o.sku].map(String).includes(isbn)) eslesen.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') yigin.push(v);
  }
  // Aynı ISBN'li birden çok düğüm olabilir (ör. Kitapyurdu: teklifsiz Book + teklifli Product); teklifli olan seçilir.
  return eslesen.find((o) => o.offers) ?? eslesen[0] ?? null;
}
const sayi = (v: unknown): number | null => {
  if (v == null) return null;
  const s = String(v).trim();
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const stok = (a: unknown): boolean | null => (a == null ? null : /InStock|LimitedAvailability|PreOrder/i.test(String(a)));
function ldTeklif(o: Record<string, any>): { fiyat: number | null; stokta: boolean | null; kargo: string | null } {
  const of = ([] as any[]).concat(o.offers ?? [])[0] ?? {};
  const fiyat = sayi(of.price ?? of.lowPrice);
  const sd = ([] as any[]).concat(of.shippingDetails ?? [])[0];
  const kv = sd?.shippingRate?.value;
  const kargo = kv == null ? null : Number(kv) === 0 ? 'Ücretsiz kargo' : `Kargo ${kv} TL`;
  return { fiyat, stokta: stok(of.availability), kargo };
}
const temiz = (u: string) => u.split('?')[0].split('#')[0];
const katla = (s: string) =>
  s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const gorunenMetin = (html: string) =>
  html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/(\d)\s*([.,])\s*(\d\d)\b/g, '$1$2$3'); // "159,<small>50" → "159,50"
const tl = (n: number) => n.toFixed(2).replace('.', ',');

// ── Mağazalar ────────────────────────────────────────────────────────────────

/** D&R: arama tam ISBN eşleşmesinde doğrudan ürün sayfasına yönlenir; ürün sayfasında JSON-LD Product+Offer. */
const dr: Magaza = {
  id: 'dr', ad: 'D&R', robotsArama: false, // robots: Disallow: /search?
  async ara(isbn) {
    const { html, url } = await getir(`https://www.dr.com.tr/search?q=${isbn}`);
    if (!/urunno=/.test(url)) return null;
    const o = ldUrun(html, isbn);
    if (!o) return null;
    const t = ldTeklif(o);
    if (!t.fiyat) return null;
    // D&R'nin JSON-LD'si tükenmiş üründe de InStock + eski fiyat yazıyor (ölçüldü: Stalin, 62 TL "Stoğu Tükendi").
    // Gerçek durum: görünen fiyat kutusu (js-text-current-price) ve "Sepete Ekle" yoksa stok yok.
    const satista = /js-text-current-price/.test(html) && /Sepete Ekle/.test(html);
    return { magaza: 'dr', magazaAd: 'D&R', fiyat: t.fiyat, listeFiyati: sayi(html.match(/data-old-price="([\d.,]+)"/)?.[1]), stokta: satista ? t.stokta : false, adres: temiz(url), kargo: t.kargo, baslik: String(o.name ?? ''), kaynak: 'json-ld' };
  },
};

/** BKM Kitap: /arama?q=ISBN sayfasında JSON-LD ItemList → Product (isbn, offers). */
const bkm: Magaza = {
  id: 'bkm', ad: 'BKM Kitap', robotsArama: true,
  async ara(isbn) {
    const { html } = await getir(`https://www.bkmkitap.com/arama?q=${isbn}`);
    const o = ldUrun(html, isbn);
    if (!o || !ldTeklif(o).fiyat) {
      // 7 Kasım ölçümü: arama sayfasının JSON-LD'sinde ürün yok; T-Soft PRODUCT_DATA kaydının code alanı ISBN'dir.
      const pd = urunVerisi(html).find((x) => String(x.code) === isbn);
      const fiyat = sayi(pd?.total_sale_price);
      if (!pd || !fiyat) return null;
      return { magaza: 'bkm', magazaAd: 'BKM Kitap', fiyat, listeFiyati: sayi(pd.total_base_price), stokta: Number(pd.quantity) > 0, adres: `https://www.bkmkitap.com/${String(pd.url).replace(/^\//, '')}`, kargo: null, baslik: String(pd.name ?? ''), kaynak: 'product-data' };
    }
    const t = ldTeklif(o);
    if (!t.fiyat) return null;
    const pd = urunVerisi(html)[0];
    return { magaza: 'bkm', magazaAd: 'BKM Kitap', fiyat: t.fiyat, listeFiyati: pd?.total_base_price ?? null, stokta: t.stokta ?? (pd ? pd.quantity > 0 : null), adres: temiz(String(o.url ?? '')), kargo: t.kargo, baslik: String(o.name ?? ''), kaynak: 'json-ld' };
  },
};

/** T-Soft altyapısı (BKM, Kitapsepeti): sayfadaki PRODUCT_DATA.push(JSON.parse('…')) kayıtları. */
function urunVerisi(html: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  // İçerik tek tırnaklı JS dizesi: önce JS kaçışları çözülür (\\" → ", \\\\u0131 → \\u0131), sonra JSON çözülür.
  const jsDize = (x: string) => x.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) =>
    e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' } as Record<string, string>)[e] ?? e);
  for (const m of html.matchAll(/PRODUCT_DATA\.push\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)\)/g)) {
    try { out.push(JSON.parse(jsDize(m[1]))); } catch { /* geç */ }
  }
  return out;
}

/** T-Soft mağazaları (Kitapsepeti, İstanbul Kitapçısı, Timaş): /arama?q=ISBN → PRODUCT_DATA → ürün sayfası JSON-LD ile ISBN doğrulaması. */
const tsoft = (id: string, ad: string, alan: string, yayinevi?: RegExp): Magaza => ({
  id, ad, robotsArama: true, yayinevi,
  async ara(isbn) {
    const { html } = await getir(`https://${alan}/arama?q=${isbn}`);
    for (const pd of urunVerisi(html).slice(0, 2)) {
      const adres = `https://${alan}/${String(pd.url).replace(/^\//, '')}`;
      const s = await getir(adres);
      const u = urunCikar(s.html, isbn);
      if (!u) continue;
      const fiyat = u.fiyat ?? sayi(pd.total_sale_price);
      if (!fiyat) continue;
      return { magaza: id, magazaAd: ad, fiyat, listeFiyati: sayi(pd.total_base_price), stokta: u.stokta ?? Number(pd.quantity) > 0, adres, kargo: null, baslik: String(pd.name ?? u.ad ?? ''), kaynak: 'json-ld' };
    }
    return null;
  },
});
const kitapsepeti = tsoft('kitapsepeti', 'Kitapsepeti', 'www.kitapsepeti.com');
const istanbulKitapcisi = tsoft('istanbulkitapcisi', 'İstanbul Kitapçısı', 'www.istanbulkitapcisi.com');
const timas = tsoft('timas', 'Timaş', 'timas.com.tr', /timas/);

/**
 * Ürün sayfasından fiyat. Sıra: (1) JSON-LD düğümünün gtin13/isbn/sku'su ISBN; (2) sayfanın data-prd-barcode/
 * data-prd-final-price öznitelikleri; (3) teklifli ilk JSON-LD Product + sayfadaki "ISBN/Barkod" etiketi ISBN
 * (etiket yoksa ISBN ham sayfada geçmeli). Başka baskının fiyatı böylece alınmaz.
 */
export function urunCikar(html: string, isbn: string): { fiyat: number | null; stokta: boolean | null; ad: string | null } | null {
  const o = ldUrun(html, isbn);
  if (o?.offers) { const t = ldTeklif(o); return { fiyat: t.fiyat, stokta: t.stokta, ad: o.name ?? null }; }
  const bar = html.match(/data-prd-barcode="(\d+)"[^>]*data-prd-final-price="([\d.]+)"/);
  if (bar && bar[1] === isbn) return { fiyat: sayi(bar[2]), stokta: /schema\.org\/InStock/.test(html) ? true : /OutOfStock/.test(html) ? false : null, ad: null };
  const etiket = gorunenMetin(html).match(/(?:ISBN|Barkod)[^0-9]{0,60}(97[89][\d-]{10,16})/i)?.[1]?.replace(/-/g, '');
  if (etiket ? etiket !== isbn : !html.includes(isbn)) return null;
  const ana = ldAnaUrun(html);
  if (!ana) return null;
  const t = ldTeklif(ana);
  return { fiyat: t.fiyat, stokta: t.stokta, ad: ana.name ?? null };
}
/** Teklifli ilk Product/Book düğümü (sayfanın ana ürünü). */
function ldAnaUrun(html: string): Record<string, any> | null {
  const yigin: unknown[] = ldBloklari(html).reverse();
  while (yigin.length) {
    const d = yigin.pop();
    if (Array.isArray(d)) { yigin.push(...[...d].reverse()); continue; }
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, any>;
    const tur = ([] as string[]).concat(o['@type'] ?? []);
    if ((tur.includes('Product') || tur.includes('Book')) && o.offers) return o;
    for (const v of Object.values(o).reverse()) if (v && typeof v === 'object') yigin.push(v);
  }
  return null;
}

/**
 * Genel kalıp: arama adresi → (yönlenirse doğrudan ürün sayfası) ya da sonuçlardaki ilk n ürün bağlantısı → urunCikar.
 * yayinevi: yayınevinin kendi mağazası; yalnız o yayınevinin kitapları sorulur (resmî satıcı).
 */
type Genel = { id: string; ad: string; robotsArama: boolean; arama: (isbn: string) => string; link?: RegExp; taban?: string; n?: number; yayinevi?: RegExp; stokYok?: RegExp };
const coz = (s: string) => s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const genel = (g: Genel): Magaza => ({
  id: g.id, ad: g.ad, robotsArama: g.robotsArama, yayinevi: g.yayinevi,
  async ara(isbn) {
    const ilk = await getir(g.arama(isbn));
    const adaylar: Array<{ html: string; url: string }> = [];
    if (urunCikar(ilk.html, isbn)) adaylar.push(ilk);
    else if (g.link) {
      const linkler = [...new Set([...ilk.html.matchAll(new RegExp(g.link.source, 'g'))].map((m) => coz(m[1])))].slice(0, g.n ?? 2);
      for (const l of linkler) adaylar.push(await getir(l.startsWith('http') ? l : `${g.taban}${l}`));
    }
    for (const s of adaylar) {
      const u = urunCikar(s.html, isbn);
      if (!u?.fiyat) continue;
      // Yapılandırılmış veri stok yazmıyorsa ya da yanlış yazıyorsa mağazanın görünen "tükendi" ifadesi esas alınır.
      const stokta = g.stokYok?.test(gorunenMetin(s.html)) ? false : u.stokta;
      return { magaza: g.id, magazaAd: g.ad, fiyat: u.fiyat, listeFiyati: null, stokta, adres: temiz(s.url), kargo: null, baslik: String(u.ad ?? ''), kaynak: 'json-ld' };
    }
    return null;
  },
});
// Kitapsec ve Hepsikitap editör kararıyla çıktı (7 Kasım: unvanı belirsiz mağaza yok); eski tanımlar git geçmişinde.
const dost = genel({ id: 'dost', ad: 'Dost Kitabevi', robotsArama: false /* Disallow: /search? */, arama: (i) => `https://dostkitabevi.com/search?q=${i}`, link: /<h2 class="product-title"><a href="(\/[^"]+)"/, taban: 'https://dostkitabevi.com' });
const kolektif = genel({ id: 'kolektif', ad: 'Kolektif Kitap', robotsArama: true, yayinevi: /kolektif/, arama: (i) => `https://www.kolektifkitap.com/search?q=${i}`, link: /"url":"(https:\\\/\\\/www\.kolektifkitap\.com\\\/kitaplar\\\/[^"]+)"/ });
const yordam = genel({ id: 'yordam', ad: 'Yordam Kitap', robotsArama: true, yayinevi: /yordam/, arama: (i) => `https://www.yordamkitap.com/arama?q=${i}` });
const iskultur = genel({ id: 'iskultur', ad: 'İş Kültür', robotsArama: true, yayinevi: /is bankasi|is kultur/, arama: (i) => `https://www.iskultur.com.tr/arama/${i}`, stokYok: /Fiyatı [\d.,]+ TL Tükendi/, link: /href="(https:\/\/www\.iskultur\.com\.tr\/[^"]+\.aspx)" title=/, n: 1 });
const alfa = genel({ id: 'alfa', ad: 'Alfa Kitap', robotsArama: false /* Disallow: /catalogsearch/ */, yayinevi: /^alfa/, arama: (i) => `https://www.alfakitap.com/catalogsearch/result/?q=${i}` });
const everest = genel({ id: 'everest', ad: 'Everest', robotsArama: false /* Disallow: /catalogsearch/ */, yayinevi: /everest/, arama: (i) => `https://everestyayinlari.com/catalogsearch/result/?q=${i}` });
const sel = genel({ id: 'sel', ad: 'Sel Yayıncılık', robotsArama: true, yayinevi: /^sel /, arama: (i) => `https://www.selyayincilik.com/arama/?q=${i}`, link: /href="(\/kitap\/[^"]+)"/, taban: 'https://www.selyayincilik.com', n: 1 });

/** Pandora: sitenin kendi arama JSON'u (/api/search; robots yalnız /api/uye, /api/auth… kapatıyor) → /kitap/<id> → JSON-LD. */
const pandora: Magaza = {
  id: 'pandora', ad: 'Pandora', robotsArama: true,
  async ara(isbn) {
    await sira('https://www.pandora.com.tr/');
    const r = await fetch(`https://www.pandora.com.tr/api/search?q=${isbn}`, { headers: { ...BASLIK, Accept: 'application/json' }, signal: AbortSignal.timeout(ZAMAN_ASIMI) });
    if (r.status === 403 || r.status === 429) throw new Engelli(`HTTP ${r.status}`);
    const j = (await r.json().catch(() => [])) as Array<Record<string, any>>;
    const k = j.find((x) => x.category === 'ISBN' && String(x.desc) === isbn);
    if (!k) return null;
    const s = await getir(`https://www.pandora.com.tr/kitap/${k.id}`);
    const u = urunCikar(s.html, isbn);
    if (!u?.fiyat) return null;
    return { magaza: 'pandora', magazaAd: 'Pandora', fiyat: u.fiyat, listeFiyati: null, stokta: u.stokta, adres: temiz(s.url), kargo: null, baslik: String(u.ad ?? k.title ?? ''), kaynak: 'json-ld' };
  },
};

/**
 * Kitapyurdu: ISBN araması sonuç vermiyor (sunucu tarafında "ürün bulunamadı"). Yol: başlık (+yazar) araması →
 * başlığı ve yayınevi tutan ilk 3 kart → ürün sayfası JSON-LD gtin13 == ISBN (en çok 1-2 arama + 3 ürün isteği).
 */
const kitapyurdu: Magaza = {
  id: 'kitapyurdu', ad: 'Kitapyurdu', robotsArama: true,
  async ara(isbn, ip) {
    if (!ip.baslik) return null;
    const yv = katla(ip.yayinevi ?? '').split(' ').filter((w) => w.length > 2 && !['yayinlari', 'yayinevi', 'kitap', 'yayincilik', 'yayin', 'kulturu', 'yayinlar'].includes(w));
    const bk = katla(ip.baslik.split(/[:(]/)[0]).split(' ').filter((w) => w.length > 1);
    // Önce başlık+yazar, uygun kart çıkmazsa yalnız başlık (Kitapyurdu araması yazar adıyla bazen ilgisiz sonuç döker).
    for (const sorgu of [`${ip.baslik}${ip.yazar ? ' ' + ip.yazar : ''}`, ip.baslik]) {
      const { html } = await getir(`https://www.kitapyurdu.com/index.php?route=product/list&filter_name=${encodeURIComponent(sorgu)}`);
      const kartlar = html.split(/<div\s+class="ky-product"/).slice(1).map((k) => ({
        adres: temiz((k.match(/href="(https:\/\/www\.kitapyurdu\.com\/kitap\/[^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&')),
        ad: katla(k.match(/class="ky-product-title"[^>]*>([^<]+)</)?.[1] ?? ''),
        yayinevi: katla(k.match(/ky-product-publisher">\s*<a[^>]*>([^<]+)</)?.[1] ?? ''),
      })).filter((k, i, a) => k.adres && a.findIndex((x) => x.adres === k.adres) === i);
      const uyan = kartlar.filter((k) => bk.every((w) => k.ad.includes(w)) && (!yv.length || yv.some((w) => k.yayinevi.includes(w))));
      if (process.env.FIYAT_IZ) console.error('ky', sorgu, kartlar.length, uyan.map((k) => k.adres));
      for (const k of uyan.slice(0, 3)) {
        const s = await getir(k.adres);
        const o = ldUrun(s.html, isbn);
        if (!o) continue;
        const t = ldTeklif(o);
        if (!t.fiyat) return null; // ISBN tuttu ama teklif yok: satışta değil ("Haber Ver")
        const liste = s.html.match(/Liste Fiyatı<\/b>:\s*([\d.,]+)/)?.[1];
        return { magaza: 'kitapyurdu', magazaAd: 'Kitapyurdu', fiyat: t.fiyat, listeFiyati: sayi(liste), stokta: t.stokta, adres: k.adres, kargo: t.kargo, baslik: String(o.name ?? ''), kaynak: 'json-ld' };
      }
      if (uyan.length) break;
    }
    return null;
  },
};

/** Sorgulanmayan mağazalar: neden (rapor §2'de ölçüm). Kod hiç istek atmaz. */
export const ERISILEMEZ: Record<string, string> = {
  idefix: 'WAF reddi (HTTP 511) + tsgcheck bot denetimi',
  amazon: 'Akamai bm-verify sınaması; koşullar robotu açıkça yasaklıyor (yasal yol: Ortaklık hesabı + resmî API)',
  hepsiburada: 'HTTP 403 Güvenlik sayfası', trendyol: 'Cloudflare 403', n11: 'HTTP 403', ciceksepeti: 'HTTP 403', teknosa: 'HTTP 403',
  canyayinlari: 'HTTP 403 (bot koruması)', yky: 'HTTP 403 (bot koruması)', dogankitap: 'bot koruması sayfası', domingo: 'HTTP 429',
  kitapcim: 'HTTP 403', nadirkitap: 'HTTP 403', kitapsan: 'HTTP 403',
  kirmizikedi: 'arama sonuçları sunucu HTML\'inde yok; robots search?q= ve *price* yasak',
  inkilap: 'robots /arama?urunAra= yasak; ISBN araması sonuç vermedi',
  halkkitabevi: 'arama sonuçları yalnız tarayıcıda (JS)', kitapal: 'arama sonuçları yalnız JS', kitapkalbi: 'arama sonuçları yalnız JS',
  kidega: 'arama adresi yok (JS)', nobelkitap: 'arama sonuçları yalnız JS', kitapisler: 'arama sonuçları yalnız JS',
  remzi: 'ASP.NET postback arama, GET adresi yok', iletisim: 'çevrimiçi satış yok (sepet yok)', metis: 'arama ISBN ile sonuç vermedi',
  babil: 'küçük seçki mağazası, SPA', kitap365: 'boş yanıt', ilknokta: 'bağlantı kurulamadı', eganba: 'bağlantı kurulamadı', odakitap: 'bağlantı kurulamadı',
};

/** Editör, 7 Kasım: güvenilir ve çok ziyaret edilen mağazalar + yayınevlerinin resmî mağazaları. robots.txt'nin arama yolunu
 * yasakladığı büyükler (D&R, Dost, Alfa, Everest) editör kabulüyle dahil (fiyatlar(..., { tum: true })); bot koruması yine aşılmaz. */
export const MAGAZALAR: Magaza[] = [
  kitapyurdu, dr, bkm, kitapsepeti, istanbulKitapcisi, pandora, dost,
  kolektif, yordam, iskultur, alfa, everest, timas, sel,
];

export async function fiyatlar(isbn: string, ip: Ipucu = {}, o: { tum?: boolean; dogrula?: boolean; engelli?: Set<string> } = {}): Promise<Sonuc[]> {
  return Promise.all(
    MAGAZALAR.map(async (m): Promise<Sonuc> => {
      const t0 = Date.now();
      if (m.yayinevi && !m.yayinevi.test(katla(ip.yayinevi ?? ''))) return { magaza: m.id, durum: 'atlandi', not: 'başka yayınevi', ms: 0 };
      if (o.engelli?.has(m.id)) return { magaza: m.id, durum: 'engelli', not: 'bu çalışmada engellendi, istek atılmadı', ms: 0 };
      if (!m.robotsArama && !o.tum) return { magaza: m.id, durum: 'atlandi', not: 'robots.txt arama yolunu yasaklıyor', ms: 0 };
      try {
        const t = await m.ara(isbn, ip);
        if (!t) return { magaza: m.id, durum: 'yok', not: 'ISBN eşleşen ürün yok', ms: Date.now() - t0 };
        if (o.dogrula) {
          const s = await getir(t.adres).catch(() => null);
          if (s) { const g = gorunenMetin(s.html); t.dogrulandi = g.includes(tl(t.fiyat)) || g.includes(t.fiyat.toFixed(2)); } else t.dogrulandi = null;
        }
        return { magaza: m.id, durum: 'bulundu', teklif: t, ms: Date.now() - t0 };
      } catch (e) {
        return { magaza: m.id, durum: e instanceof Engelli ? 'engelli' : 'hata', not: String((e as Error).message), ms: Date.now() - t0 };
      }
    }),
  );
}
/** Yalnız satın alınabilir (stok yok değil) teklifler, fiyata göre; en ucuz 5. */
export const enUcuz5 = (s: Sonuc[]): Teklif[] =>
  s.flatMap((x) => (x.durum === 'bulundu' && x.teklif.stokta !== false ? [x.teklif] : []))
    .sort((a, b) => a.fiyat - b.fiyat)
    .slice(0, 5);

// ── CLI ──────────────────────────────────────────────────────────────────────
const DENEME = [
  '9789750739248', '9789750718533', '9786055029357', '9789754700114', '9789750826146',
  '9786051721514', '9786254291845', '9789750530777', '9789751416636', '9786053753155',
];

if (process.argv[1] && import.meta.url.endsWith('/scripts/fiyat-dene.mts') && /fiyat-dene\.mts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const tum = args.includes('--tum');
  const dogrula = args.includes('--dogrula');
  const json = args.includes('--json');
  const isbnler = args.includes('--deneme') ? DENEME : args.filter((a) => /^97[89]\d{10}$/.test(a));
  if (!isbnler.length) { console.error('kullanım: npx tsx scripts/fiyat-dene.mts <ISBN…> | --deneme [--tum] [--dogrula] [--json]'); process.exit(1); }
  const { readFileSync } = await import('node:fs');
  const kitaplar = JSON.parse(readFileSync(new URL('../icerik/books.json', import.meta.url), 'utf8')) as Array<Record<string, any>>;
  const tumu: Array<{ isbn: string; ip: Ipucu; sonuc: Sonuc[]; en5: Teklif[] }> = [];
  for (const isbn of isbnler) {
    const k = kitaplar.find((b) => String(b.isbn13) === isbn);
    const ip: Ipucu = { baslik: k?.title, yazar: k?.authorName, yayinevi: k?.publisher };
    const sonuc = await fiyatlar(isbn, ip, { tum, dogrula });
    const en5 = enUcuz5(sonuc);
    tumu.push({ isbn, ip, sonuc, en5 });
    if (json) continue;
    console.log(`\n${isbn}  ${ip.baslik ?? '?'} — ${ip.yazar ?? ''} (${ip.yayinevi ?? ''})`);
    for (const s of sonuc)
      console.log(`  · ${s.magaza.padEnd(12)} ${s.durum.padEnd(8)} ${s.durum === 'bulundu' ? `${tl(s.teklif.fiyat)} TL${s.teklif.stokta === false ? ' (stok yok)' : ''}${s.teklif.dogrulandi == null ? '' : s.teklif.dogrulandi ? ' ✓sayfada' : ' ✗sayfada yok'}` : s.not} ${s.ms}ms`);
    console.log('  En ucuz 5:');
    en5.forEach((t, i) => console.log(`   ${i + 1}. ${t.magazaAd.padEnd(12)} ${tl(t.fiyat).padStart(8)} TL  ${t.stokta === false ? 'stok yok' : 'stokta'}  ${t.adres}`));
    if (!en5.length) console.log('   (hiçbir mağazada bulunamadı)');
  }
  if (json) console.log(JSON.stringify(tumu, null, 2));
}
