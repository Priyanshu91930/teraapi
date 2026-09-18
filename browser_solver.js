import { extractNdusValue } from './api/parse.js';

let puppeteerModule = null;

async function getPuppeteer() {
  if (puppeteerModule) return puppeteerModule;
  try {
    puppeteerModule = await import('puppeteer');
    return puppeteerModule;
  } catch (e) {
    try {
      puppeteerModule = await import('puppeteer-core');
      return puppeteerModule;
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Solves TeraBox 400141 Verification Challenge by opening the share link
 * in a real Headless Chromium browser on the VPS IP with active NDUS session cookies.
 *
 * @param {string} verifyUrl - TeraBox share link or verification URL
 * @param {string} ndusToken - Active NDUS cookie session token
 * @returns {Promise<{success: boolean, cookies?: string, error?: string}>}
 */
export async function solveChallengeWithBrowser(verifyUrl, ndusToken) {
  if (!verifyUrl) return { success: false, error: 'No verifyUrl provided' };

  console.log(`[VPS Real Browser Solver] 🌐 Launching Headless Chromium to solve verification challenge...`);
  console.log(`[VPS Real Browser Solver] Target URL: ${verifyUrl}`);

  const pMod = await getPuppeteer();
  if (!pMod) {
    console.warn(`[VPS Real Browser Solver] Puppeteer is not installed yet on VPS. Run 'npm i puppeteer' on VPS if needed.`);
    return { success: false, error: 'Puppeteer not installed' };
  }

  let browser = null;
  try {
    const puppeteer = pMod.default || pMod;
    
    // Launch headless Chromium with anti-detection flags
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,800',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const urlObj = new URL(verifyUrl);
    const domain = urlObj.hostname.replace(/^www\./, '');

    // Parse and set all session cookies from MongoDB token string (ndus, browserid, csrfToken, TSID, etc.)
    if (ndusToken) {
      const cookiePairs = ndusToken.split(';').map(c => c.trim()).filter(Boolean);
      for (const pair of cookiePairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const name = pair.substring(0, eqIdx).trim();
          const value = pair.substring(eqIdx + 1).trim();
          if (name && value) {
            await page.setCookie({
              name,
              value,
              domain: `.${domain}`,
              path: '/',
              secure: true
            }).catch(() => {});
          }
        }
      }
      console.log(`[VPS Real Browser Solver] Set all ${cookiePairs.length} session cookies from MongoDB for .${domain}`);
    }

    console.log(`[VPS Real Browser Solver] Navigating to page and executing JavaScript on VPS IP...`);
    await page.goto(verifyUrl, {
      waitUntil: 'networkidle2',
      timeout: 25000
    }).catch(e => console.warn('[VPS Real Browser Solver] Navigation timeout (continuing anyway):', e.message));

    // Stay on page for 4 seconds to execute JS telemetry & challenges
    await new Promise(resolve => setTimeout(resolve, 4000));

    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`[VPS Real Browser Solver] ✅ Browser session warmup complete on VPS IP! (${cookies.length} cookies collected)`);

    return { success: true, cookies: cookieString };
  } catch (err) {
    console.error(`[VPS Real Browser Solver] Exception during browser solve:`, err.message);
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}
