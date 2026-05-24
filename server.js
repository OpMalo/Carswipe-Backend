const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Browser-like headers to avoid being blocked ────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractPrice(text) {
  const m = text.match(/\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

function extractYear(text) {
  const m = text.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? parseInt(m[0]) : null;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  } catch { return 'Recently'; }
}

// ─── KIJIJI ──────────────────────────────────────────────────────────────────
// Uses public RSS feeds — very reliable, no JS rendering needed
async function scrapeKijiji(params = {}) {
  const locations = params.location
    ? [params.location]
    : ['ville-de-montreal/c174l1700281', 'laval/c174l1700179', 'longueuil-south-shore/c174l1700215'];

  const results = [];

  for (const loc of locations) {
    try {
      const url = `https://www.kijiji.ca/rss-feed/cars-trucks/${loc}`;
      console.log(`Fetching Kijiji RSS: ${url}`);
      const resp = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const parsed = await xml2js.parseStringPromise(resp.data, { explicitArray: true });

      const items = parsed?.rss?.channel?.[0]?.item || [];
      for (const item of items.slice(0, 15)) {
        const title = item.title?.[0] || '';
        const link = item.link?.[0] || '';
        const desc = item.description?.[0] || '';
        const pubDate = item.pubDate?.[0] || '';

        // Extract image from description HTML
        const imgMatch = desc.match(/src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
        const img = imgMatch ? imgMatch[1].replace(/\/\$_\d+\./, '/$_59.') : null; // get larger image

        // Parse title: "2019 Honda Civic SI - $22,500"
        const year = extractYear(title);
        const price = extractPrice(title) || extractPrice(desc);
        const titleClean = title.replace(/\s*-?\s*\$[\d,]+/, '').trim();

        // Split make/model from title after year
        let make = '', model = '';
        const titleAfterYear = titleClean.replace(/\b\d{4}\b/, '').trim();
        const words = titleAfterYear.split(' ').filter(Boolean);
        if (words.length >= 2) { make = words[0]; model = words.slice(1).join(' '); }
        else if (words.length === 1) { make = words[0]; }

        const locationName = loc.split('/')[0].replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        results.push({
          id: `kijiji-${Buffer.from(link).toString('base64').slice(0, 12)}`,
          source: 'Kijiji',
          year: year || new Date().getFullYear(),
          make: make || 'Unknown',
          model: model || titleClean,
          title: titleClean,
          price,
          mileage: 0,
          transmission: 'Unknown',
          fuel: 'Gasoline',
          color: 'Unknown',
          condition: 'Used',
          location: locationName,
          seller: 'Private Seller',
          sellerType: 'Private Seller',
          description: stripHtml(desc).slice(0, 250),
          img,
          url: link,
          posted: timeAgo(pubDate),
        });
      }
    } catch (err) {
      console.error(`Kijiji error (${loc}):`, err.message);
    }
  }
  return results;
}

// ─── AUTOHEBDO ───────────────────────────────────────────────────────────────
// AutoHebdo is a Next.js app; car data lives in the __NEXT_DATA__ JSON blob
async function scrapeAutoHebdo(params = {}) {
  try {
    const province = params.province || 'Quebec';
    const url = `https://www.autohebdo.net/cars/used/?prx=-1&prv=${province}&loc=0&sts=New-Used&incs=0&wf=1`;
    console.log(`Fetching AutoHebdo: ${url}`);
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(resp.data);

    // ── Strategy 1: __NEXT_DATA__ JSON blob ──────────────────────────────────
    const nextDataRaw = $('#__NEXT_DATA__').html();
    if (nextDataRaw) {
      const data = JSON.parse(nextDataRaw);
      const pp = data?.props?.pageProps || {};

      // Try several known property paths
      const listings =
        pp.listings ||
        pp.searchResults?.listings ||
        pp.vehicles ||
        pp.results?.listings ||
        pp.initialState?.searchResults?.listings ||
        [];

      if (listings.length > 0) {
        return listings.slice(0, 20).map((car, i) => ({
          id: `autohebdo-${car.id || car.adId || i}`,
          source: 'AutoHebdo',
          year: car.year || car.modelYear || car.vehicleYear || 0,
          make: car.make || car.makeName || car.brand || '',
          model: car.model || car.modelName || '',
          price: car.price || car.askingPrice || car.listingPrice || 0,
          mileage: car.mileage || car.odometer || car.kilometres || 0,
          transmission: car.transmission || car.gearbox || 'Unknown',
          fuel: car.fuelType || car.fuel || 'Gasoline',
          color: car.exteriorColor || car.colour || car.color || 'Unknown',
          condition: car.condition || car.status || 'Used',
          location: car.location?.city || car.city || car.municipality || province,
          seller: car.sellerName || car.dealerName || car.contactName || 'Seller',
          sellerType: car.dealerId || car.isDealerListing ? 'Dealer' : 'Private Seller',
          description: (car.description || car.comments || '').slice(0, 250),
          img: car.photos?.[0]?.url || car.images?.[0]?.url || car.imageUrl || car.thumbnail || null,
          url: car.url ? `https://www.autohebdo.net${car.url}` : `https://www.autohebdo.net/cars/used/`,
          posted: car.postedDate || car.createdAt || 'Recently',
        }));
      }
    }

    // ── Strategy 2: Cheerio HTML parsing (fallback) ───────────────────────────
    const results = [];
    const selectors = [
      '.listing-item', '[data-testid="listing-card"]',
      '.result-item', '.vehicle-card', '.srp-item',
      'article[data-qa]', '[class*="ListingCard"]', '[class*="VehicleCard"]'
    ];

    for (const sel of selectors) {
      const els = $(sel);
      if (els.length > 0) {
        els.each((i, el) => {
          if (i >= 20) return false;
          const $el = $(el);
          const title = $el.find('[class*="title"], h2, h3').first().text().trim();
          const price = parseInt($el.find('[class*="price"], [data-price]').first().text().replace(/[^0-9]/g, '')) || 0;
          const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');
          const link = $el.find('a').first().attr('href') || '';
          results.push({
            id: `autohebdo-html-${i}`,
            source: 'AutoHebdo',
            year: extractYear(title) || 0,
            make: '', model: title,
            price, mileage: 0,
            transmission: 'Unknown', fuel: 'Gasoline', color: 'Unknown', condition: 'Used',
            location: province,
            seller: 'Seller', sellerType: 'Unknown',
            description: '',
            img: img || null,
            url: link.startsWith('http') ? link : `https://www.autohebdo.net${link}`,
            posted: 'Recently',
          });
        });
        if (results.length > 0) break;
      }
    }
    return results;

  } catch (err) {
    console.error('AutoHebdo error:', err.message);
    return [];
  }
}

// ─── CARGURUS ────────────────────────────────────────────────────────────────
async function scrapeCarGurus(params = {}) {
  try {
    const zip = params.zip || 'H1A'; // Default: Montreal
    const url = `https://www.cargurus.com/Cars/inventoryListing/viewDetailsFilterViewInventoryListing.action?zip=${zip}&showNegotiable=true&sortDir=ASC&sourceContext=carGurusHomePageModel&distance=100&sortType=PRICE`;
    console.log(`Fetching CarGurus: ${url}`);
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(resp.data);

    // CarGurus embeds JSON in window.dataLayer or __INITIAL_STATE__
    let listings = [];
    $('script').each((i, el) => {
      const text = $(el).html() || '';
      const match = text.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/s) ||
                    text.match(/"listings"\s*:\s*(\[.+?\])/s);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          const items = Array.isArray(parsed) ? parsed : (parsed.listings || []);
          listings = items.slice(0, 15).map((car, idx) => ({
            id: `cargurus-${car.id || idx}`,
            source: 'CarGurus',
            year: car.carYear || car.year || 0,
            make: car.makeName || car.make || '',
            model: car.modelName || car.model || '',
            price: car.price || car.listingPrice || 0,
            mileage: car.mileage || 0,
            transmission: car.transmission || 'Unknown',
            fuel: car.fuelType || 'Gasoline',
            color: car.exteriorColor || 'Unknown',
            condition: car.condition || 'Used',
            location: car.localizedCity || car.city || 'Canada',
            seller: car.sellerName || car.dealer?.name || 'Dealer',
            sellerType: 'Dealer',
            description: (car.description || '').slice(0, 250),
            img: car.mainPictureUrl || car.images?.[0] || null,
            url: car.vdpUrl ? `https://www.cargurus.com${car.vdpUrl}` : 'https://www.cargurus.com',
            posted: 'Recently',
          }));
        } catch {}
      }
    });
    return listings;
  } catch (err) {
    console.error('CarGurus error:', err.message);
    return [];
  }
}

// ─── MOCK DATA FALLBACK ───────────────────────────────────────────────────────
// Shown when all scrapers fail, so the app never shows blank
function getMockListings() {
  return [
    {
      id: 'mock-1', source: 'AutoHebdo', year: 2020, make: 'Toyota', model: 'Camry XSE',
      price: 24900, mileage: 42000, transmission: 'Automatic', fuel: 'Gasoline',
      color: 'Midnight Black', condition: 'Used', location: 'Montréal, QC',
      seller: 'Marc T.', sellerType: 'Private Seller', posted: '2 days ago',
      description: 'Clean Carfax, all service records. Non-smoker, no accidents. Loaded with tech package.',
      img: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?w=800&q=80',
      url: 'https://www.autohebdo.net',
    },
    {
      id: 'mock-2', source: 'Kijiji', year: 2019, make: 'Honda', model: 'Civic Sport',
      price: 17500, mileage: 68000, transmission: 'Manual', fuel: 'Gasoline',
      color: 'Rallye Red', condition: 'Used', location: 'Laval, QC',
      seller: 'Julie C.', sellerType: 'Private Seller', posted: '5 hours ago',
      description: 'Fun to drive sporty hatchback. New tires last year, all maintenance done.',
      img: 'https://images.unsplash.com/photo-1590362891991-f776e747a588?w=800&q=80',
      url: 'https://www.kijiji.ca',
    },
    {
      id: 'mock-3', source: 'CarGurus', year: 2021, make: 'Mazda', model: 'CX-5 GT',
      price: 34900, mileage: 18000, transmission: 'Automatic', fuel: 'Gasoline',
      color: 'Soul Red Crystal', condition: 'Used', location: 'Longueuil, QC',
      seller: 'Véhicules Prestige', sellerType: 'Dealer', posted: '6 hours ago',
      description: 'Like new! Leather seats, Bose audio, turbo engine. Full warranty transferable.',
      img: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=800&q=80',
      url: 'https://www.cargurus.com',
    },
  ];
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /api/listings  — main endpoint, fetches all sources in parallel
app.get('/api/listings', async (req, res) => {
  try {
    console.log('Fetching listings from all sources...');
    const [kijiji, autohebdo, cargurus] = await Promise.allSettled([
      scrapeKijiji(req.query),
      scrapeAutoHebdo(req.query),
      scrapeCarGurus(req.query),
    ]);

    const all = [
      ...(kijiji.status === 'fulfilled' ? kijiji.value : []),
      ...(autohebdo.status === 'fulfilled' ? autohebdo.value : []),
      ...(cargurus.status === 'fulfilled' ? cargurus.value : []),
    ].filter(c => c.price > 0 || c.title || c.make);

    // Use mock data if everything failed
    const listings = all.length > 0 ? all : getMockListings();

    // Shuffle so sources are interleaved
    listings.sort(() => Math.random() - 0.5);

    res.json({
      listings,
      count: listings.length,
      sources: {
        kijiji: kijiji.status === 'fulfilled' ? kijiji.value.length : 0,
        autohebdo: autohebdo.status === 'fulfilled' ? autohebdo.value.length : 0,
        cargurus: cargurus.status === 'fulfilled' ? cargurus.value.length : 0,
      },
      isMockData: all.length === 0,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Fatal error in /api/listings:', err.message);
    res.json({ listings: getMockListings(), count: 3, isMockData: true, error: err.message });
  }
});

// GET /api/listings/kijiji — test Kijiji scraper alone
app.get('/api/listings/kijiji', async (req, res) => {
  const data = await scrapeKijiji(req.query);
  res.json({ listings: data, count: data.length });
});

// GET /api/listings/autohebdo — test AutoHebdo scraper alone
app.get('/api/listings/autohebdo', async (req, res) => {
  const data = await scrapeAutoHebdo(req.query);
  res.json({ listings: data, count: data.length });
});

// Health check (Render uses this)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/', (req, res) => {
  res.send(`
    <h1>CarSwipe Backend 🚗</h1>
    <p>Status: Running ✅</p>
    <p><a href="/api/listings">View listings (all sources)</a></p>
    <p><a href="/api/listings/kijiji">Test Kijiji only</a></p>
    <p><a href="/api/listings/autohebdo">Test AutoHebdo only</a></p>
    <p><a href="/health">Health check</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ CarSwipe backend running on http://localhost:${PORT}`);
  console.log(`   Try: http://localhost:${PORT}/api/listings`);
});
