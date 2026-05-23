// SmallCode — Web Browse Tool (Playwright + Stealth)
// Full browser automation for web search and page interaction
// Optional: requires `npm install playwright playwright-extra puppeteer-extra-plugin-stealth`
// Falls back to simple fetch if not installed.
//
// Tools exposed:
//   web_search — search the web, return top results
//   web_fetch  — fetch a URL, extract readable text
//   web_browse — full browser: navigate, click, extract (advanced)
//
// Safety: every URL passed to webFetch is validated against the SSRF
// guard so an LLM can't trick the tool into hitting cloud-metadata URLs
// or RFC1918 internal services without the operator's explicit consent.

const { sanitizeToolOutput } = require('../../security/sanitize');

let _ssrfGuard = null;
function _assertUrlSafe(url) {
  if (!_ssrfGuard) {
    try { _ssrfGuard = require('../../compiled/providers/ssrf_guard'); }
    catch { _ssrfGuard = { assertEndpointAllowed: () => {} }; }
  }
  // For web fetch we apply a stricter rule: outside of explicit allowlist or
  // LLM_ALLOW_PUBLIC_ENDPOINTS=1, refuse RFC1918/loopback too. Reuse the
  // base guard for metadata/link-local protection regardless.
  _ssrfGuard.assertEndpointAllowed(url);
  if (process.env.LLM_ALLOW_PUBLIC_ENDPOINTS === '1') return;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    throw new Error('web_fetch refuses loopback URLs');
  }
  if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) {
    throw new Error('web_fetch refuses RFC1918 URLs');
  }
}

let playwright = null;
let stealthPlugin = null;
let browserInstance = null;

// Lazy-load playwright (optional dependency)
function loadPlaywright() {
  if (playwright) return true;
  try {
    playwright = require('playwright-extra');
    stealthPlugin = require('puppeteer-extra-plugin-stealth');
    playwright.chromium.use(stealthPlugin());
    return true;
  } catch {
    return false;
  }
}

async function getBrowser() {
  if (browserInstance) return browserInstance;
  if (!loadPlaywright()) return null;
  browserInstance = await playwright.chromium.launch({ headless: true });
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// ─── Web Search (DuckDuckGo, no API key) ─────────────────────────────────────

async function webSearch(query, maxResults = 5) {
  // Try Playwright first for better results
  const browser = await getBrowser();
  if (browser) {
    return await _searchWithBrowser(browser, query, maxResults);
  }
  // Fallback: DuckDuckGo HTML lite (no JS needed)
  return await _searchWithFetch(query, maxResults);
}

async function _searchWithBrowser(browser, query, maxResults) {
  const page = await browser.newPage();
  try {
    await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, { waitUntil: 'networkidle', timeout: 15000 });
    
    const results = await page.evaluate((max) => {
      const items = document.querySelectorAll('[data-result],.result');
      return Array.from(items).slice(0, max).map(el => {
        const link = el.querySelector('a[href]');
        const snippet = el.querySelector('.result__snippet, .snippet');
        return {
          title: link?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
        };
      }).filter(r => r.url && r.title);
    }, maxResults);

    return results;
  } catch (e) {
    return [{ title: 'Search failed', url: '', snippet: e.message }];
  } finally {
    await page.close();
  }
}

async function _searchWithFetch(query, maxResults) {
  // DuckDuckGo HTML lite — works without JS
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmallCode/0.4.0)' },
    });
    const html = await response.text();
    
    // Parse results from HTML
    const results = [];
    const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) && results.length < maxResults) {
      results.push({
        title: match[2].trim(),
        url: match[1],
        snippet: match[3].replace(/<[^>]+>/g, '').trim(),
      });
    }
    return results.length > 0 ? results : [{ title: 'No results', url: '', snippet: `No results for: ${query}` }];
  } catch (e) {
    return [{ title: 'Search failed', url: '', snippet: e.message }];
  }
}

// ─── Web Fetch (extract readable content) ────────────────────────────────────

async function webFetch(url, maxChars = 5000) {
  // SSRF guard — refuse URLs targeting metadata, RFC1918, or loopback
  // unless the operator explicitly opted in. This blocks an LLM from
  // tricking us into reading cloud metadata or local admin panels.
  try {
    _assertUrlSafe(String(url || ''));
  } catch (e) {
    return `Refused: ${e.message}`;
  }
  // Try Playwright for JS-heavy pages
  const browser = await getBrowser();
  if (browser) {
    return await _fetchWithBrowser(browser, url, maxChars);
  }
  // Fallback: simple fetch
  return await _fetchSimple(url, maxChars);
}

async function _fetchWithBrowser(browser, url, maxChars) {
  const page = await browser.newPage();
  try {
    // Re-validate every URL the page touches (initial request, redirects,
    // and any subresource the document fetches). page.goto follows HTTP
    // redirects with no per-hop control, so an LLM-supplied URL that 302s
    // to 169.254.169.254 would otherwise bypass the guard — matching the
    // exact "don't auto-follow" reasoning _fetchSimple already documents
    // a few lines down.
    await page.route('**/*', async (route) => {
      try {
        _assertUrlSafe(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Extract readable text (strip nav, ads, etc.)
    const text = await page.evaluate(() => {
      // Remove noise elements
      const noise = document.querySelectorAll('nav, header, footer, script, style, [role="navigation"], .ad, .sidebar');
      noise.forEach(el => el.remove());
      
      const main = document.querySelector('main, article, [role="main"], .content, #content');
      const target = main || document.body;
      return target.innerText || target.textContent || '';
    });

    // Sanitize: external page could embed ANSI escape sequences in
    // copyable text snippets, or pasted secrets in error/log examples.
    return sanitizeToolOutput(text).slice(0, maxChars).trim();
  } catch (e) {
    return `Failed to fetch ${url}: ${e.message}`;
  } finally {
    await page.close();
  }
}

async function _fetchSimple(url, maxChars) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmallCode/0.4.0)' },
      timeout: 10000,
      redirect: 'manual', // Don't auto-follow — a 30x to 169.254.169.254 would bypass the SSRF guard
    });
    if (response.status >= 300 && response.status < 400) {
      return `Refused: redirect to ${response.headers.get('location') || '(unknown)'} not followed`;
    }
    const html = await response.text();
    // Strip HTML tags for readable text
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return sanitizeToolOutput(text).slice(0, maxChars);
  } catch (e) {
    return `Failed to fetch ${url}: ${e.message}`;
  }
}

module.exports = { webSearch, webFetch, closeBrowser, loadPlaywright };

// Auto-close browser on process exit to prevent leaked Chromium processes.
// This handles normal exit, SIGINT, and uncaught exceptions.
process.on('exit', () => { if (browserInstance) { try { browserInstance.close(); } catch {} } });
process.on('SIGINT', () => { if (browserInstance) { try { browserInstance.close(); } catch {} } process.exit(130); });
process.on('SIGTERM', () => { if (browserInstance) { try { browserInstance.close(); } catch {} } process.exit(143); });
