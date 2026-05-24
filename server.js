const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Rotate through different User-Agents to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Kijiji/18.5.0 (iPhone; iOS 17.0; Scale/3.00)',
];

function randomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getHeaders(referer) {
  return {
    'User-Agent': randomAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'DNT': '1',
    ...(referer ? { 'Referer': referer } : {}),
  };
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
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr) {
  try {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  } catch { return 'Recently'; }
}

// ─── KIJIJI RSS ───────────────────────────────────────────────────────────────
// Kijiji provides public RSS feeds for each category/location
async function scrapeKijiji() {
  const RSS_URLS = [
    'https://www.kijiji.ca/rss-feed/cars-trucks/ville-de-montreal/c174l1700281',
    'https://www.kijiji.ca/rss-feed/cars-trucks/laval/c174l1700179',
    'https://www.kijiji.ca/rss-feed/cars-trucks/canada/c174l0',
    'https://www.kijiji.ca/rss-feed/cars-trucks/quebec/c174l9004',
  ];

  const results = [];

  for (const url of RSS_URLS) {
    try {
      console.log(`[Kijiji] Fetching: ${url}`);
      const resp = await axios.get(url, {
        headers: getHeaders('https://www.kijiji.ca/'),
        timeout: 20000,
        maxRedirects: 5,
      });

      const parsed = await xml2js.parseStringPromise(resp.data, { explicitArray: true });
      const items = parsed?.rss?.channel?.[0]?.item || [];
      console.log(`[Kijiji] Got ${items.length} items from ${url}`);

      for (const item of items.slice(0, 12)) {
        const title   = item.title?.[0] || '';
        const link    = item.link?.[0] || '';
        const desc    = item.description?.[0] || '';
        const pubDate = item.pubDate?.[0] || '';

        // Extract larger image from description
        const imgMatch = desc.match(/src="([^"]+)"/i);
        let img = imgMatch ? imgMatch[1] : null;
        if (img) img = img.replace(/\/\$_\d+\./, '/$_57.'); // get medium size

        const price = extractPrice(title) || extractPrice(desc);
        const year  = extractYear(title);

        // Parse "2019 Honda Civic Sport - $17,500" → make + model
        const titleClean = title.replace(/\s*[-–]\s*\$[\d,]+.*/, '').trim();
        const afterYear  = titleClean.replace(/^\d{4}\s*/, '').trim();
        const words      = afterYear.split(/\s+/);
        const make       = words[0] || 'Unknown';
        const model      = words.slice(1).join(' ') || titleClean;

        // Get city from URL  (e.g. /v-cars.../ville-de-montreal/...)
        const cityMatch = link.match(/\/([a-z-]+)\/\d{10,}/);
        const city = cityMatch
          ? cityMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          : 'Québec';

        results.push({
          id: `kijiji-${Buffer.from(link).toString('base64').slice(-10)}-${Date.now()}`,
          source: 'Kijiji',
          year: year || 0,
          make, model,
          title: titleClean,
          price,
          mileage: 0,
          transmission: detectTransmission(title + desc),
          fuel: detectFuel(title + desc),
          color: 'Unknown',
          condition: 'Used',
          location: city,
          seller: 'Private Seller',
          sellerType: 'Private Seller',
          description: stripHtml(desc).slice(0, 250),
          img,
          url: link,
          posted: timeAgo(pubDate),
        });
      }

      if (results.length >= 15) break; // enough from this source
    } catch (err) {
      console.error(`[Kijiji] Error on ${url}: ${err.message}`);
    }
  }

  console.log(`[Kijiji] Total: ${results.length} listings`);
  return results;
}

// ─── AUTOHEBDO ────────────────────────────────────────────────────────────────
async function scrapeAutoHebdo() {
  const URLS = [
    'https://www.autohebdo.net/cars/used/?prx=-1&prv=Quebec&loc=0&sts=New-Used&incs=0&wf=1',
    'https://www.autohebdo.net/cars/used/?prx=-1&prv=Ontario&loc=0&sts=New-Used&incs=0&wf=1',
  ];

  for (const url of URLS) {
    try {
      console.log(`[AutoHebdo] Fetching: ${url}`);
      const resp = await axios.get(url, {
        headers: getHeaders('https://www.google.com/'),
        timeout: 20000,
        maxRedirects: 5,
      });

      const $ = cheerio.load(resp.data);

      // Strategy 1: __NEXT_DATA__ JSON blob (Next.js app)
      const nextRaw = $('script#__NEXT_DATA__').html();
      if (nextRaw) {
        const data = JSON.parse(nextRaw);
        const pp = data?.props?.pageProps || {};
        const listings =
          pp.listings || pp.searchResults?.listings || pp.vehicles ||
          pp.results?.listings || pp.initialState?.listings || [];

        if (listings.length > 0) {
          console.log(`[AutoHebdo] Found ${listings.length} listings via __NEXT_DATA__`);
          return listings.slice(0, 15).map((car, i) => ({
            id: `autohebdo-${car.id || car.adId || i}`,
            source: 'AutoHebdo',
            year: car.year || car.modelYear || 0,
            make: car.make || car.makeName || car.brand || '',
            model: car.model || car.modelName || '',
            price: car.price || car.askingPrice || 0,
            mileage: car.mileage || car.odometer || car.kilometres || 0,
            transmission: car.transmission || 'Unknown',
            fuel: car.fuelType || 'Gasoline',
            color: car.exteriorColor || car.colour || 'Unknown',
            condition: car.condition || 'Used',
            location: car.location?.city || car.city || 'Québec',
            seller: car.sellerName || car.dealerName || 'Seller',
            sellerType: (car.dealerId || car.isDealerListing) ? 'Dealer' : 'Private Seller',
            description: (car.description || '').slice(0, 250),
            img: car.photos?.[0]?.url || car.images?.[0]?.url || car.imageUrl || null,
            url: car.url ? `https://www.autohebdo.net${car.url}` : url,
            posted: car.postedDate || 'Recently',
          }));
        }
      }

      // Strategy 2: Look for JSON in any script tag containing listing data
      let found = [];
      $('script').each((_, el) => {
        if (found.length > 0) return;
        const src = $(el).html() || '';
        const patterns = [
          /window\.__STORE__\s*=\s*(\{.+?\});/s,
          /"listings"\s*:\s*(\[.+?\])/s,
          /"vehicles"\s*:\s*(\[.+?\])/s,
          /"results"\s*:\s*(\[.+?\])/s,
        ];
        for (const p of patterns) {
          const m = src.match(p);
          if (m) {
            try {
              const parsed = JSON.parse(m[1]);
              const arr = Array.isArray(parsed) ? parsed : (parsed.listings || []);
              if (arr.length > 0) { found = arr; break; }
            } catch {}
          }
        }
      });

      if (found.length > 0) {
        console.log(`[AutoHebdo] Found ${found.length} via script scan`);
        return found.slice(0, 15).map((car, i) => ({
          id: `autohebdo-s-${i}`,
          source: 'AutoHebdo',
          year: car.year || 0, make: car.make || '',
          model: car.model || '', price: car.price || 0,
          mileage: car.mileage || 0, transmission: car.transmission || 'Unknown',
          fuel: car.fuelType || 'Gasoline', color: car.colour || 'Unknown',
          condition: car.condition || 'Used', location: car.city || 'Québec',
          seller: car.dealerName || 'Seller', sellerType: car.dealerId ? 'Dealer' : 'Private',
          description: (car.description || '').slice(0, 250),
          img: car.photos?.[0]?.url || null,
          url, posted: 'Recently',
        }));
      }

      console.log('[AutoHebdo] No structured data found, trying HTML selectors');

      // Strategy 3: CSS selectors as last resort
      const results = [];
      $('[class*="listing"], [class*="Listing"], [class*="result"], [class*="vehicle"], article').each((i, el) => {
        if (i >= 15) return false;
        const $e = $(el);
        const titleEl = $e.find('h2, h3, [class*="title"]').first();
        const title = titleEl.text().trim();
        if (!title || title.length < 5) return;
        const priceText = $e.find('[class*="price"], [class*="Price"]').first().text();
        const price = extractPrice(priceText);
        const img = $e.find('img').first().attr('src') || $e.find('img').first().attr('data-src');
        const link = $e.find('a[href*="/cars/"]').first().attr('href') || '';
        results.push({
          id: `autohebdo-html-${i}`, source: 'AutoHebdo',
          year: extractYear(title) || 0, make: '', model: title,
          price, mileage: 0, transmission: 'Unknown', fuel: 'Gasoline',
          color: 'Unknown', condition: 'Used', location: 'Québec',
          seller: 'Seller', sellerType: 'Unknown', description: '',
          img: img || null,
          url: link.startsWith('http') ? link : `https://www.autohebdo.net${link}`,
          posted: 'Recently',
        });
      });
      if (results.length > 0) {
        console.log(`[AutoHebdo] Found ${results.length} via HTML selectors`);
        return results;
      }

    } catch (err) {
      console.error(`[AutoHebdo] Error: ${err.message}`);
    }
  }
  return [];
}

// ─── CRAIGSLIST (very reliable backup — Montreal + Ottawa) ────────────────────
async function scrapeCraigslist() {
  const FEEDS = [
    { url: 'https://montreal.craigslist.org/search/cta?format=rss&purveyor=owner', city: 'Montréal, QC' },
    { url: 'https://ottawa.craigslist.org/search/cta?format=rss&purveyor=owner', city: 'Ottawa, ON' },
    { url: 'https://toronto.craigslist.org/search/cta?format=rss&purveyor=owner', city: 'Toronto, ON' },
  ];

  const results = [];
  for (const feed of FEEDS) {
    try {
      console.log(`[Craigslist] Fetching: ${feed.url}`);
      const resp = await axios.get(feed.url, {
        headers: getHeaders('https://craigslist.org/'),
        timeout: 15000,
      });

      const parsed = await xml2js.parseStringPromise(resp.data, { explicitArray: true });
      const items = parsed?.rss?.channel?.[0]?.item || [];
      console.log(`[Craigslist] Got ${items.length} items`);

      for (const item of items.slice(0, 10)) {
        const title   = item.title?.[0] || '';
        const link    = item.link?.[0] || '';
        const desc    = item.description?.[0] || '';
        const pubDate = item.pubDate?.[0] || '';

        const imgMatch = desc.match(/<img[^>]+src="([^"]+)"/i);
        const price = extractPrice(title) || extractPrice(desc);
        if (price === 0) continue; // skip listings without price

        const year  = extractYear(title);
        const titleClean = title.replace(/\s*[-–]?\s*\$[\d,]+.*/, '').trim();
        const afterYear  = titleClean.replace(/^\d{4}\s*/, '').trim();
        const words      = afterYear.split(/\s+/);

        results.push({
          id: `craigslist-${Buffer.from(link).toString('base64').slice(-10)}`,
          source: 'Kijiji', // Display as Kijiji since we don't have Craigslist badge
          year: year || 0,
          make: words[0] || 'Unknown',
          model: words.slice(1).join(' ') || titleClean,
          title: titleClean,
          price,
          mileage: extractMileage(desc),
          transmission: detectTransmission(title + desc),
          fuel: detectFuel(title + desc),
          color: 'Unknown',
          condition: 'Used',
          location: feed.city,
          seller: 'Private Seller',
          sellerType: 'Private Seller',
          description: stripHtml(desc).slice(0, 250),
          img: imgMatch ? imgMatch[1] : null,
          url: link,
          posted: timeAgo(pubDate),
        });
      }
    } catch (err) {
      console.error(`[Craigslist] Error: ${err.message}`);
    }
  }
  console.log(`[Craigslist] Total: ${results.length} listings`);
  return results;
}

// ─── Helper detectors ──────────────────────────────────────────────────────────
function detectTransmission(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('manual') || t.includes('manuell') || t.includes('standard') || t.includes('6-speed') || t.includes('5-speed')) return 'Manual';
  if (t.includes('automatic') || t.includes('automatique') || t.includes('cvt') || t.includes('dsg')) return 'Automatic';
  return 'Unknown';
}

function detectFuel(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('electric') || t.includes('électrique') || t.includes('tesla') || t.includes('ev')) return 'Electric';
  if (t.includes('hybrid') || t.includes('hybride')) return 'Hybrid';
  if (t.includes('diesel')) return 'Diesel';
  return 'Gasoline';
}

function extractMileage(text) {
  const m = (text || '').match(/([\d,]+)\s*(km|kilometers|kilometres)/i);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

// ─── Mock fallback ─────────────────────────────────────────────────────────────
function getMockListings() {
  return [
    {
      id:'mock-1', source:'AutoHebdo', year:2021, make:'Toyota', model:'Camry XSE',
      price:24900, mileage:42000, transmission:'Automatic', fuel:'Gasoline',
      color:'Midnight Black', condition:'Used', location:'Montréal, QC',
      seller:'Marc T.', sellerType:'Private Seller', posted:'2 days ago',
      description:'Clean Carfax, all service records available. Non-smoker, no accidents.',
      img:'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?w=800&q=80',
      url:'https://www.autohebdo.net',
    },
    {
      id:'mock-2', source:'Kijiji', year:2019, make:'Honda', model:'Civic Sport',
      price:17500, mileage:68000, transmission:'Manual', fuel:'Gasoline',
      color:'Rallye Red', condition:'Used', location:'Laval, QC',
      seller:'Julie C.', sellerType:'Private Seller', posted:'5 hours ago',
      description:'Fun to drive sporty hatchback. New tires, all maintenance done.',
      img:'https://images.unsplash.com/photo-1590362891991-f776e747a588?w=800&q=80',
      url:'https://www.kijiji.ca',
    },
    {
      id:'mock-3', source:'CarGurus', year:2020, make:'BMW', model:'330i xDrive',
      price:38500, mileage:35000, transmission:'Automatic', fuel:'Gasoline',
      color:'Alpine White', condition:'Certified', location:'Québec City, QC',
      seller:'Prestige Auto', sellerType:'Dealer', posted:'1 day ago',
      description:'CPO with full BMW warranty. Premium package, panoramic roof.',
      img:'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800&q=80',
      url:'https://www.cargurus.com',
    },
  ];
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  console.log('\n=== New listings request ===');
  const start = Date.now();

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

  console.log(`=== Done in ${Date.now()-start}ms: kijiji=${kijiji.length} autohebdo=${autohebdo.length} craigslist=${craigslist.length} ===\n`);

  res.json({
    listings,
    count: listings.length,
    sources: { kijiji: kijiji.length, autohebdo: autohebdo.length, craigslist: craigslist.length },
    isMockData: isMock,
    lastUpdated: new Date().toISOString(),
  });
});

app.get('/api/listings/kijiji',    async (req, res) => { const d = await scrapeKijiji();    res.json({ listings: d, count: d.length }); });
app.get('/api/listings/autohebdo', async (req, res) => { const d = await scrapeAutoHebdo(); res.json({ listings: d, count: d.length }); });
app.get('/api/listings/craigslist',async (req, res) => { const d = await scrapeCraigslist();res.json({ listings: d, count: d.length }); });

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/', (req, res) => res.send(`
  <h1>CarSwipe Backend 🚗</h1>
  <p><a href="/api/listings">All listings</a> | <a href="/api/listings/kijiji">Kijiji</a> | <a href="/api/listings/autohebdo">AutoHebdo</a> | <a href="/api/listings/craigslist">Craigslist</a></p>
`));

app.listen(PORT, () => console.log(`✅ CarSwipe backend on port ${PORT}`));
