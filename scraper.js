const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG (set these as Railway env variables) ──
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://nkqjpcnslmadmvnuwvdh.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || 'sb_secret_B3Yrt1PvKFXfClf9Ff3BLw_OeX9n0xNc';
const UXENTO_COOKIE   = process.env.UXENTO_COOKIE   || 'YOUR_TURNKEY_SESSION_VALUE';
const SCRAPE_URL      = 'https://app.uxento.io/vision';
const INTERVAL_MS     = 30_000; // scrape every 30 seconds

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

async function scrape() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1280, height: 900 });

    // Set cookies properly
    await page.setCookie(
      {
        name:     'turnkey_session',
        value:    UXENTO_COOKIE,
        domain:   'app.uxento.io',
        path:     '/',
        secure:   true,
        httpOnly: false,
        sameSite: 'None',
      },
      {
        name:     'turnkey_session',
        value:    UXENTO_COOKIE,
        domain:   '.uxento.io',
        path:     '/',
        secure:   true,
        httpOnly: false,
        sameSite: 'None',
      }
    );

    // Navigate to uxento vision feed
    await page.goto(SCRAPE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Wait for tweet cards to appear
    await page.waitForSelector('[class*="tweet"], [class*="post"], [class*="feed-item"]', {
      timeout: 20_000,
    }).catch(() => console.log('Selector timeout — trying generic scrape'));

    // Small extra wait for dynamic content
    await new Promise(r => setTimeout(r, 3000));

    // ── EXTRACT TWEETS ──
    const tweets = await page.evaluate(() => {
      const results = [];

      // Try multiple possible selectors uxento might use
      const cards = document.querySelectorAll(
        '[class*="tweet-card"], [class*="post-card"], [class*="feed-card"], ' +
        '[class*="TweetCard"], [class*="PostCard"], ' +
        '.feed-item, .tweet-item, .post-item'
      );

      // Fallback: grab all articles or large divs that look like posts
      const targets = cards.length > 0 ? cards :
        document.querySelectorAll('article, [role="article"]');

      targets.forEach((card, i) => {
        if (i > 50) return; // max 50 per scrape

        try {
          // Handle / display name
          const handleEl = card.querySelector(
            '[class*="handle"], [class*="username"], [class*="screen-name"], ' +
            'a[href*="twitter.com"], a[href*="x.com"]'
          );
          const nameEl = card.querySelector(
            '[class*="display-name"], [class*="name"], [class*="author"]'
          );
          const avatarEl  = card.querySelector('img[class*="avatar"], img[class*="profile"], img[src*="pbs.twimg"]');
          const contentEl = card.querySelector('[class*="content"], [class*="text"], [class*="body"], p');
          const timeEl    = card.querySelector('time, [class*="time"], [class*="ago"], [class*="timestamp"]');
          const mediaEl   = card.querySelector('img[class*="media"], video, img[src*="pbs.twimg.com/media"]');
          const verifiedEl= card.querySelector('[class*="verified"], [aria-label*="verified"], svg[class*="verified"]');
          const followEl  = card.querySelector('[class*="followers"], [class*="follower-count"]');

          let handle = '';
          if (handleEl) {
            const href = handleEl.getAttribute('href') || '';
            const match = href.match(/(?:twitter\.com|x\.com)\/([^/?]+)/);
            handle = match ? match[1] : (handleEl.textContent.trim().replace('@', ''));
          }

          const content = contentEl ? contentEl.innerText?.trim() : '';
          if (!content && !handle) return; // skip empty cards

          // Generate a stable ID from handle + content snippet
          const id = btoa(unescape(encodeURIComponent(
            (handle + content.slice(0, 40)).replace(/\s/g, '')
          ))).slice(0, 32);

          results.push({
            id,
            handle:       handle || 'unknown',
            display_name: nameEl    ? nameEl.innerText?.trim()    : handle,
            avatar_url:   avatarEl  ? avatarEl.src                : null,
            verified:     !!verifiedEl,
            followers:    followEl  ? followEl.innerText?.trim()  : null,
            content,
            media_url:    mediaEl   ? (mediaEl.src || mediaEl.currentSrc || null) : null,
            media_type:   mediaEl?.tagName === 'VIDEO' ? 'video' : (mediaEl ? 'image' : null),
            tweet_time:   timeEl    ? timeEl.getAttribute('datetime') || timeEl.innerText?.trim() : new Date().toISOString(),
          });
        } catch (e) {
          // skip bad card
        }
      });

      return results;
    });

    console.log(`[${new Date().toISOString()}] Found ${tweets.length} posts`);

    if (tweets.length === 0) {
      console.log('No tweets found — uxento DOM selectors may need updating');
      // Take a screenshot to debug
      await page.screenshot({ path: '/tmp/debug.png', fullPage: false });
      console.log('Debug screenshot saved to /tmp/debug.png');
    }

    // ── UPSERT TO SUPABASE ──
    if (tweets.length > 0) {
      const { error } = await supabase
        .from('tweets')
        .upsert(tweets, { onConflict: 'id' });

      if (error) {
        console.error('Supabase upsert error:', error.message);
      } else {
        console.log(`[${new Date().toISOString()}] Upserted ${tweets.length} posts to Supabase`);
      }
    }

  } catch (err) {
    console.error('Scrape error:', err.message);
  } finally {
    await browser.close();
  }
}

// ── RUN LOOP ──
(async () => {
  console.log('Shill scraper starting...');
  await scrape(); // run immediately on start
  setInterval(scrape, INTERVAL_MS);
})();
