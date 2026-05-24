const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || '';

// Route all requests through ScraperAPI to bypass IP blocks
function scrape(url) {
  if (SCRAPER_KEY) {
    return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}`;
  }
  return url; // fallback: try direct (will likely 403)
}

function extractPrice(text) {
  const m = (text || '').match(/\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

function extractYear(text) {
  const m = (text || '').match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? parseInt(m[0]) : null;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr) {
  try {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  } catch { return 'Recently'; }
}

function detectTransmission(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('manual') || t.includes('standard') || t.includes('6-speed') || t.includes('5-speed')) return 'Manual';
  if (t.includes('automatic') || t.includes('automatique') || t.includes('cvt') || t.includes('dsg')) return 'Automatic';
  return 'Unknown';
}

function detectFuel(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('electric') || t.includes('électrique')) return 'Electric';
  if (t.includes('hybrid') || t.includes('hybride')) return 'Hybrid';
  if (t.includes('diesel')) return 'Diesel';
  return 'Gasoline';
}

// ─── KIJIJI (RSS feed via ScraperAPI) ─────────────────────────────────────────
async function scrapeKijiji() {
  const RSS_URLS = [
    'https://www.kijiji.ca/rss-feed/cars-trucks/ville-de-montreal/c174l1700281',
    'https://www.kijiji.ca/rss-feed/cars-trucks/laval/c174l1700179',
    'https://www.kijiji.ca/rss-feed/cars-trucks/longueuil-south-shore/c174l1700215',
    'https://www.kijiji.ca/rss-feed/cars-trucks/quebec/c174l9004',
  ];

  const results = [];

  for (const rssUrl of RSS_URLS) {
    try {
      console.log(`[Kijiji] Fetching: ${rssUrl}`);
      const resp = await axios.get(scrape(rssUrl), { timeout: 30000 });
      const parsed = await xml2js.parseStringPromise(resp.data, { explicitArray: true });
      const items = parsed?.rss?.channel?.[0]?.item || [];
      console.log(`[Kijiji] Got ${items.length} items`);

      for (const item of items.slice(0, 12)) {
        const title   = item.title?.[0] || '';
        const link    = item.link?.[0] || '';
        const desc    = item.description?.[0] || '';
        const pubDate = item.pubDate?.[0] || '';

        const imgMatch = desc.match(/src="([^"]+)"/i);
        let img = imgMatch ? imgMatch[1] : null;
        if (img) img = img.replace(/\/\$_\d+\./, '/$_57.');

        const price = extractPrice(title) || extractPrice(desc);
        const year  = extractYear(title);
        const titleClean = title.replace(/\s*[-–]\s*\$[\d,]+.*/, '').trim();
        const afterYear  = titleClean.replace(/^\d{4}\s*/, '').trim();
        const words      = afterYear.split(/\s+/);
        const make       = words[0] || 'Unknown';
        const model      = words.slice(1).join(' ') || titleClean;

        const cityMatch = link.match(/\/([a-z-]+)\/\d{10,}/);
        const city = cityMatch
          ? cityMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          : 'Québec';

        results.push({
          id: `kijiji-${Buffer.from(link).toString('base64').slice(-10)}-${i || Date.now()}`,
          source: 'Kijiji',
          year: year || 0, make, model,
          price, mileage: 0,
          transmission: detectTransmission(title + desc),
          fuel: detectFuel(title + desc),
          color: 'Unknown', condition: 'Used',
          location: city,
          seller: 'Private Seller', sellerType: 'Private Seller',
          description: stripHtml(desc).slice(0, 250),
          img, url: link,
          posted: timeAgo(pubDate),
        });
      }

      if (results.length >= 15) break;
    } catch (err) {
      console.error(`[Kijiji] Error on ${rssUrl}: ${err.message}`);
    }
  }

  console.log(`[Kijiji] Total: ${results.length}`);
  return results;
}

// ─── AUTOHEBDO (Next.js app via ScraperAPI) ────────────────────────────────────
async function scrapeAutoHebdo() {
  const targetUrl = 'https://www.autohebdo.net/cars/used/?prx=-1&prv=Quebec&loc=0&sts=New-Used&incs=0&wf=1';
  try {
    console.log(`[AutoHebdo] Fetching...`);
    const resp = await axios.get(scrape(targetUrl), { timeout: 30000 });
    const $ = cheerio.load(resp.data);

    // Strategy 1: __NEXT_DATA__ JSON
    const nextRaw = $('script#__NEXT_DATA__').html();
    if (nextRaw) {
      const data = JSON.parse(nextRaw);
      const pp = data?.props?.pageProps || {};
      const listings =
        pp.listings || pp.searchResults?.listings || pp.vehicles ||
        pp.results?.listings || pp.initialState?.listings || [];

      if (listings.length > 0) {
        console.log(`[AutoHebdo] Found ${listings.length} via __NEXT_DATA__`);
        return listings.slice(0, 15).map((car, i) => ({
          id: `autohebdo-${car.id || i}`,
          source: 'AutoHebdo',
          year: car.year || car.modelYear || 0,
          make: car.make || car.makeName || '',
          model: car.model || car.modelName || '',
          price: car.price || car.askingPrice || 0,
          mileage: car.mileage || car.odometer || 0,
          transmission: car.transmission || 'Unknown',
          fuel: car.fuelType || 'Gasoline',
          color: car.exteriorColor || car.colour || 'Unknown',
          condition: car.condition || 'Used',
          location: car.location?.city || car.city || 'Québec',
          seller: car.sellerName || car.dealerName || 'Seller',
          sellerType: (car.dealerId || car.isDealerListing) ? 'Dealer' : 'Private Seller',
          description: (car.description || '').slice(0, 250),
          img: car.photos?.[0]?.url || car.images?.[0]?.url || null,
          url: car.url ? `https://www.autohebdo.net${car.url}` : targetUrl,
          posted: car.postedDate || 'Recently',
        }));
      }
    }

    // Strategy 2: scan all script tags for listing arrays
    let found = [];
    $('script').each((_, el) => {
      if (found.length > 0) return;
      const src = $(el).html() || '';
      for (const pattern of [
        /"listings"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
        /"vehicles"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
        /"results"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
      ]) {
        const m = src.match(pattern);
        if (m) {
          try {
            const arr = JSON.parse(m[1]);
            if (Array.isArray(arr) && arr.length > 0) { found = arr; return false; }
          } catch {}
        }
      }
    });

    if (found.length > 0) {
      console.log(`[AutoHebdo] Found ${found.length} via script scan`);
      return found.slice(0, 15).map((car, i) => ({
        id: `autohebdo-s-${i}`, source: 'AutoHebdo',
        year: car.year || 0, make: car.make || '', model: car.model || '',
        price: car.price || 0, mileage: car.mileage || 0,
        transmission: car.transmission || 'Unknown', fuel: car.fuelType || 'Gasoline',
        color: car.colour || 'Unknown', condition: car.condition || 'Used',
        location: car.city || 'Québec', seller: car.dealerName || 'Seller',
        sellerType: car.dealerId ? 'Dealer' : 'Private',
        description: (car.description || '').slice(0, 250),
        img: car.photos?.[0]?.url || null,
        url: targetUrl, posted: 'Recently',
      }));
    }

    console.log('[AutoHebdo] No structured data found');
    return [];
  } catch (err) {
    console.error(`[AutoHebdo] Error: ${err.message}`);
    return [];
  }
}

// ─── CRAIGSLIST (very open RSS, rarely blocks) ─────────────────────────────────
async function scrapeCraigslist() {
  const FEEDS = [
    { url: 'https://montreal.craigslist.org/search/cta?format=rss&purveyor=owner', city: 'Montréal, QC' },
    { url: 'https://ottawa.craigslist.org/search/cta?format=rss&purveyor=owner',   city: 'Ottawa, ON' },
    { url: 'https://toronto.craigslist.org/search/cta?format=rss&purveyor=owner',  city: 'Toronto, ON' },
  ];

  const results = [];
  for (const feed of FEEDS) {
    try {
      console.log(`[Craigslist] Fetching: ${feed.url}`);
      const resp = await axios.get(scrape(feed.url), { timeout: 25000 });
      const parsed = await xml2js.parseStringPromise(resp.data, { explicitArray: true });
      const items = parsed?.rss?.channel?.[0]?.item || [];
      console.log(`[Craigslist] Got ${items.length} items from ${feed.city}`);

      for (const item of items.slice(0, 10)) {
        const title   = item.title?.[0] || '';
        const link    = item.link?.[0] || '';
        const desc    = item.description?.[0] || '';
        const pubDate = item.pubDate?.[0] || '';

        const price = extractPrice(title) || extractPrice(desc);
        if (price === 0) continue;

        const imgMatch = desc.match(/<img[^>]+src="([^"]+)"/i);
        const year     = extractYear(title);
        const titleClean = title.replace(/\s*[-–]?\s*\$[\d,]+.*/, '').trim();
        const afterYear  = titleClean.replace(/^\d{4}\s*/, '').trim();
        const words      = afterYear.split(/\s+/);

        results.push({
          id: `cl-${Buffer.from(link).toString('base64').slice(-10)}`,
          source: 'Kijiji', // show as Kijiji badge since we don't have Craigslist one
          year: year || 0,
          make: words[0] || 'Unknown',
          model: words.slice(1).join(' ') || titleClean,
          price, mileage: 0,
          transmission: detectTransmission(title + desc),
          fuel: detectFuel(title + desc),
          color: 'Unknown', condition: 'Used',
          location: feed.city,
          seller: 'Private Seller', sellerType: 'Private Seller',
          description: stripHtml(desc).slice(0, 250),
          img: imgMatch ? imgMatch[1] : null,
          url: link,
          posted: timeAgo(pubDate),
        });
      }
    } catch (err) {
      console.error(`[Craigslist] Error (${feed.city}): ${err.message}`);
    }
  }
  console.log(`[Craigslist] Total: ${results.length}`);
  return results;
}

// ─── Mock fallback ─────────────────────────────────────────────────────────────
function getMockListings() {
  return [
    { id:'m1', source:'AutoHebdo', year:2021, make:'Toyota', model:'Camry XSE', price:24900, mileage:42000, transmission:'Automatic', fuel:'Gasoline', color:'Midnight Black', condition:'Used', location:'Montréal, QC', seller:'Marc T.', sellerType:'Private Seller', posted:'2 days ago', description:'Clean Carfax, all service records. Non-smoker, no accidents.', img:'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?w=800&q=80', url:'https://www.autohebdo.net' },
    { id:'m2', source:'Kijiji', year:2019, make:'Honda', model:'Civic Sport', price:17500, mileage:68000, transmission:'Manual', fuel:'Gasoline', color:'Rallye Red', condition:'Used', location:'Laval, QC', seller:'Julie C.', sellerType:'Private Seller', posted:'5 hours ago', description:'Fun to drive sporty hatchback. New tires, all maintenance done.', img:'https://images.unsplash.com/photo-1590362891991-f776e747a588?w=800&q=80', url:'https://www.kijiji.ca' },
    { id:'m3', source:'CarGurus', year:2020, make:'BMW', model:'330i xDrive', price:38500, mileage:35000, transmission:'Automatic', fuel:'Gasoline', color:'Alpine White', condition:'Certified', location:'Québec City, QC', seller:'Prestige Auto', sellerType:'Dealer', posted:'1 day ago', description:'CPO with full BMW warranty. Premium package, panoramic roof.', img:'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800&q=80', url:'https://www.cargurus.com' },
  ];
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  console.log(`\n=== New request (ScraperAPI: ${SCRAPER_KEY ? 'YES ✅' : 'NO ❌'}) ===`);

  const [kijijiRes, autohebdoRes, craigslistRes] = await Promise.allSettled([
    scrapeKijiji(),
    scrapeAutoHebdo(),
    scrapeCraigslist(),
  ]);

  const kijiji     = kijijiRes.status     === 'fulfilled' ? kijijiRes.value     : [];
  const autohebdo  = autohebdoRes.status  === 'fulfilled' ? autohebdoRes.value  : [];
  const craigslist = craigslistRes.status === 'fulfilled' ? craigslistRes.value : [];

  const all = [...kijiji, ...autohebdo, ...craigslist]
    .filter(c => c.price > 0 || (c.make && c.make !== 'Unknown'));

  const isMock = all.length === 0;
  const listings = isMock ? getMockListings() : all;
  listings.sort(() => Math.random() - 0.5);

  console.log(`=== kijiji=${kijiji.length} autohebdo=${autohebdo.length} craigslist=${craigslist.length} isMock=${isMock} ===\n`);

  res.json({
    listings, count: listings.length,
    sources: { kijiji: kijiji.length, autohebdo: autohebdo.length, craigslist: craigslist.length },
    isMockData: isMock,
    lastUpdated: new Date().toISOString(),
  });
});

app.get('/api/listings/kijiji',     async (req, res) => { const d = await scrapeKijiji();     res.json({ listings: d, count: d.length }); });
app.get('/api/listings/autohebdo',  async (req, res) => { const d = await scrapeAutoHebdo();  res.json({ listings: d, count: d.length }); });
app.get('/api/listings/craigslist', async (req, res) => { const d = await scrapeCraigslist(); res.json({ listings: d, count: d.length }); });

app.get('/health', (req, res) => res.json({ status: 'ok', scraperApi: !!SCRAPER_KEY }));
app.get('/', (req, res) => res.send(`<h1>CarSwipe 🚗</h1><p>ScraperAPI: ${SCRAPER_KEY ? '✅ configured' : '❌ missing'}</p><p><a href="/api/listings">All listings</a> | <a href="/api/listings/kijiji">Kijiji</a> | <a href="/api/listings/autohebdo">AutoHebdo</a> | <a href="/api/listings/craigslist">Craigslist</a></p>`));

app.listen(PORT, () => console.log(`✅ CarSwipe backend on port ${PORT} | ScraperAPI: ${SCRAPER_KEY ? 'enabled' : 'MISSING'}`));
