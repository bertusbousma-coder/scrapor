const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://nkqjpcnslmadmvnuwvdh.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || 'sb_secret_B3Yrt1PvKFXfClf9Ff3BLw_OeX9n0xNc';
const UXENTO_COOKIE   = process.env.UXENTO_COOKIE;
const SCRAPE_URL      = 'https://app.uxento.io/vision';
const INTERVAL_MS     = 30_000;

// Find chromium path - Railway installs it via apt
const CHROMIUM_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

async function findChromium() {
  const fs = require('fs');
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) {
      console.log('Found chromium at:', p);
      return p;
    }
  }
  // fallback - let puppeteer-core find it
  return '/usr/bin/chromium';
}

async function scrape() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const executablePath = await findChromium();

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Set cookie
    await page.setCookie({
      name:     'turnkey_session',
      value:    UXENTO_COOKIE,
      domain:   'app.uxento.io',
      path:     '/',
      secure:   true,
      httpOnly: false,
      sameSite: 'Lax',
    });

    await page.goto(SCRAPE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Wait for content
    await new Promise(r => setTimeout(r, 5000));

    // Take screenshot for debugging
    await page.screenshot({ path: '/tmp/debug.png' });
    console.log('Screenshot saved');

    // Get page title to confirm login worked
    const title = await page.title();
    console.log('Page title:', title);

    // Extract tweets
    const tweets = await page.evaluate(() => {
      const results = [];
      
      // Log all class names to help debug selectors
      const allDivs = document.querySelectorAll('div[class]');
      const classes = new Set();
      allDivs.forEach(d => {
        d.className.split(' ').forEach(c => { if(c) classes.add(c); });
      });
      console.log('Classes found:', JSON.stringify([...classes].slice(0, 50)));

      // Try to find tweet containers
      const selectors = [
        '[class*="tweet"]',
        '[class*="post"]', 
        '[class*="feed"]',
        'article',
        '[role="article"]',
        '[data-testid="tweet"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          console.log(`Found ${found.length} elements with selector: ${sel}`);
          cards = found;
          break;
        }
      }

      cards.forEach((card, i) => {
        if (i > 50) return;
        try {
          const text = card.innerText?.trim();
          if (!text || text.length < 10) return;

          const links = card.querySelectorAll('a[href*="x.com"], a[href*="twitter.com"]');
          let handle = '';
          links.forEach(l => {
            const m = l.getAttribute('href')?.match(/(?:x|twitter)\.com\/([^/?]+)/);
            if (m && m[1] !== 'i' && !handle) handle = m[1];
          });

          const imgs = card.querySelectorAll('img');
          let avatar = '';
          imgs.forEach(img => {
            if (img.src?.includes('pbs.twimg.com/profile') && !avatar) avatar = img.src;
          });

          const timeEl = card.querySelector('time, [datetime]');
          const id = btoa(unescape(encodeURIComponent((handle + text.slice(0,30)).replace(/\s/g,'')))).slice(0,32);

          results.push({
            id,
            handle: handle || 'unknown',
            display_name: handle,
            avatar_url: avatar || null,
            verified: false,
            followers: null,
            content: text.slice(0, 1000),
            media_url: null,
            media_type: null,
            tweet_time: timeEl?.getAttribute('datetime') || new Date().toISOString(),
          });
        } catch(e) {}
      });

      return results;
    });

    console.log(`Found ${tweets.length} posts`);

    if (tweets.length > 0) {
      const { error } = await supabase.from('tweets').upsert(tweets, { onConflict: 'id' });
      if (error) console.error('Supabase error:', error.message);
      else console.log(`Upserted ${tweets.length} posts`);
    }

  } catch (err) {
    console.error('Scrape error:', err.message);
  } finally {
    await browser.close();
  }
}

(async () => {
  if (!UXENTO_COOKIE) {
    console.error('UXENTO_COOKIE env variable not set!');
    process.exit(1);
  }
  console.log('Shill scraper starting...');
  await scrape();
  setInterval(scrape, INTERVAL_MS);
})();
