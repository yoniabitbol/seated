// One shared real-Chrome process (headless=new) hosting many lightweight
// incognito contexts - each with its own proxy, timezone and viewport.
// Memory: ~1 browser process + small contexts, instead of N headed windows.
const { chromium } = require('playwright');
const { HOOK_SCRIPT } = require('./captcha');

// Minimal, internally-consistent stealth: hide automation signals without
// spoofing values that would contradict the real browser. Two headless tells
// MUST be fixed: the UA contains "HeadlessChrome" and navigator.userAgentData
// is missing entirely - both are trivial bot signals for Prelude/Cloudflare.
// Built per Chrome major version by buildStealthScript().
function buildStealthScript(chromeMajor) {
  return `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  }
  window.chrome = window.chrome || { runtime: {} };
  if (!navigator.userAgentData) {
    const brands = [
      { brand: 'Not(A:Brand', version: '99' },
      { brand: 'Google Chrome', version: '${chromeMajor}' },
      { brand: 'Chromium', version: '${chromeMajor}' },
    ];
    const full = [
      { brand: 'Not(A:Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: '${chromeMajor}.0.0.0' },
      { brand: 'Chromium', version: '${chromeMajor}.0.0.0' },
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: 'macOS',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'arm',
        bitness: '64',
        brands,
        fullVersionList: full,
        mobile: false,
        model: '',
        platform: 'macOS',
        platformVersion: '15.0.0',
        uaFullVersion: '${chromeMajor}.0.0.0',
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
    };
    Object.defineProperty(navigator, 'userAgentData', { get: () => uaData });
  }
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p);
  } catch (e) {}
  // headless reports 24-bit color; this machine's display is 30-bit
  try { Object.defineProperty(screen, 'colorDepth', { get: () => 30 }); } catch (e) {}
})();
`;
}

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
];

// Heavy third parties the form doesn't need. NEVER block
// challenges.cloudflare.com, api.seated.com or the Prelude SDK.
const BLOCKED_DOMAINS = [
  'sentry.io',
  'posthog.com',
  'facebook.net',
  'facebook.com',
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'mapbox.com',
];

class BrowserManager {
  constructor({ headed = false } = {}) {
    this.headed = headed;
    this.browser = null;
    this.launching = null;
    this.identity = null; // {ua, major} resolved once from the real browser
  }

  async get() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = this._launch();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  // Read the real browser's UA, strip the headless tell, extract Chrome major.
  async _resolveIdentity(browser) {
    if (this.identity) return this.identity;
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const rawUa = await page.evaluate(() => navigator.userAgent);
      const ua = rawUa.replace(/HeadlessChrome/g, 'Chrome');
      const major = (rawUa.match(/Chrome\/(\d+)/) || [])[1] || '150';
      this.identity = { ua, major };
      console.log(`  [browser] identity: Chrome/${major} (UA de-headlessed)`);
      return this.identity;
    } finally {
      await ctx.close();
    }
  }

  async _launch() {
    console.log(`  [browser] launching ${this.headed ? 'HEADED' : 'headless'} Chrome...`);
    const browser = await chromium.launch({
      headless: !this.headed,
      channel: 'chrome', // real Chrome -> headless=new, much stealthier than bundled chromium
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-features=Translate',
        '--force-color-profile=srgb',
      ],
    });
    browser.on('disconnected', () => {
      console.error('  [browser] DISCONNECTED - will relaunch on next task');
      if (this.browser === browser) this.browser = null;
    });
    return browser;
  }

  // Fresh incognito context for one attempt: per-context proxy, de-headlessed
  // UA, timezone from the proxy's geo, randomized viewport, stealth + Turnstile
  // hook init scripts.
  async newContext(proxy) {
    const browser = await this.get();
    const { ua, major } = await this._resolveIdentity(browser);
    const base = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    const viewport = {
      width: base.width + Math.floor(Math.random() * 41) - 20,
      height: base.height + Math.floor(Math.random() * 41) - 20,
    };
    const context = await browser.newContext({
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      userAgent: ua,
      viewport,
      locale: 'en-US',
      timezoneId: (proxy.geo && proxy.geo.timezone) || 'America/New_York',
      serviceWorkers: 'block',
    });
    await context.addInitScript(buildStealthScript(major) + '\n' + HOOK_SCRIPT);
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(45000);
    await this._setupRouting(context);
    return context;
  }

  // Block images/fonts/media and analytics domains to cut bandwidth/CPU.
  // CF challenge frames are always allowed through (even their images).
  async _setupRouting(context) {
    await context.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      if (url.includes('challenges.cloudflare.com')) return route.continue();
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      if (BLOCKED_DOMAINS.some(d => url.includes(d))) return route.abort();
      return route.continue();
    });
  }

  async closeContext(context, tag) {
    if (!context) return;
    try {
      await Promise.race([context.close(), new Promise(r => setTimeout(r, 5000))]);
    } catch {}
  }

  async shutdown() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null;
  }
}

module.exports = { BrowserManager };
