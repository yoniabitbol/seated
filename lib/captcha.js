// Cloudflare Turnstile solving: CapSolver token + injection (primary), with the
// old iframe-click loop as automatic fallback.
//
// Seated renders the widget via Ember's JS API (turnstile.render(el, {callback})),
// so a solved token only counts if the app's callback fires with it. The
// HOOK_SCRIPT (installed as an init script before any page JS) wraps
// window.turnstile.render and captures each widget's callback on its element.
const cfg = require('./config');

class TurnstileError extends Error {
  constructor(msg) { super(msg); this.kind = 'turnstile'; }
}

let capsolverDisabled = false; // flipped on hard errors (e.g. no balance)

// Installed in every context via addInitScript (runs before page scripts).
// IMPORTANT: do NOT pre-define window.turnstile (defineProperty). Turnstile's
// api.js checks for an existing property to detect duplicate loads - if it
// finds one, it bails out and the widget never renders. Instead, poll until
// api.js defines it naturally, then wrap its render() method in place.
const HOOK_SCRIPT = `
(() => {
  if (window.__tsHookInstalled) return;
  window.__tsHookInstalled = true;
  window.__tsCallbacks = window.__tsCallbacks || [];
  const wrap = (ts) => {
    if (!ts || window.__tsHookDone || typeof ts.render !== 'function') return;
    window.__tsHookDone = true;
    const orig = ts.render;
    ts.render = function (el, opts) {
      try {
        const node = (el && el.nodeType === 1) ? el : document.querySelector(el);
        if (opts && opts.callback) window.__tsCallbacks.push({ node: node || null, callback: opts.callback });
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  };
  const iv = setInterval(() => {
    try {
      if (window.turnstile) wrap(window.turnstile);
      if (window.__tsHookDone) clearInterval(iv);
    } catch (e) {}
  }, 50);
  setTimeout(() => clearInterval(iv), 120000); // don't poll forever
})();
`;

// ── CapSolver client ──

async function capsolverPost(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function capsolverSolve(task, tag) {
  const created = await capsolverPost('https://api.capsolver.com/createTask', {
    clientKey: cfg.CAPSOLVER_KEY,
    task,
  });
  if (created.errorId) {
    const desc = `${created.errorCode}: ${created.errorDescription}`;
    if (/BALANCE|INSUFFICIENT/i.test(desc)) {
      capsolverDisabled = true;
      console.error(`  [${tag}] CapSolver balance empty - disabling for this run, using click fallback`);
    }
    throw new TurnstileError(`capsolver createTask: ${desc}`);
  }
  const taskId = created.taskId;
  if (!taskId) throw new TurnstileError(`capsolver no taskId: ${JSON.stringify(created)}`);

  const deadline = Date.now() + cfg.CAPSOLVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await capsolverPost('https://api.capsolver.com/getTaskResult', {
      clientKey: cfg.CAPSOLVER_KEY,
      taskId,
    });
    if (res.errorId) throw new TurnstileError(`capsolver getTaskResult: ${res.errorCode}: ${res.errorDescription}`);
    if (res.status === 'ready') return res.solution;
    if (res.status && res.status !== 'processing') {
      throw new TurnstileError(`capsolver solve failed: ${JSON.stringify(res)}`);
    }
  }
  throw new TurnstileError('capsolver solve timed out');
}

// ── Page-side helpers ──

// True once the Verify button is enabled (Turnstile passed). The phone page also
// has an unrelated always-enabled "Next" submit, so gate on the Verify text.
async function verifyEnabled(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
    const verify = btns.filter(b => (b.innerText || '').trim().toLowerCase() === 'verify');
    return verify.length > 0 && verify.some(b => !b.disabled);
  }).catch(() => false);
}

async function extractSiteKey(page) {
  const key = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    const m = document.documentElement.innerHTML.match(/sitekey["'=:\s]+(0x[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }).catch(() => null);
  return key || cfg.TURNSTILE_SITEKEY || null;
}

// Push a solved token into the page: hidden response inputs + the hooked
// render-callback registry (the real token callback that sets the app's
// state). window.turnstileCallback is only a last resort: on Seated it is
// the api.js ONLOAD/render function, and calling it re-renders the widget.
async function injectToken(page, token) {
  return page.evaluate((tok) => {
    let fired = false;
    document.querySelectorAll('[name="cf-turnstile-response"]').forEach(el => {
      el.value = tok;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    (window.__tsCallbacks || []).forEach(entry => {
      if (typeof entry.callback !== 'function') return;
      try { entry.callback(tok); fired = true; } catch (e) {}
    });
    if (!fired) {
      document.querySelectorAll('.cf-turnstile, [data-sitekey]').forEach(el => {
        const cb = el.getAttribute && el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') { try { window[cb](tok); fired = true; } catch (e) {} }
      });
    }
    if (!fired && typeof window.turnstileCallback === 'function') {
      try { window.turnstileCallback(tok); fired = true; } catch (e) {}
    }
    return fired;
  }, token).catch(() => false);
}

// Old approach: click the nested CF iframe checkbox, polling for Verify to
// enable. Kept as the automatic fallback.
async function clickFallback(page, tag) {
  console.log(`  [${tag}] Turnstile click fallback...`);
  const deadline = Date.now() + cfg.TURNSTILE_CLICK_FALLBACK_MS;
  let lastClick = 0;
  let clicks = 0;
  while (Date.now() < deadline) {
    if (await verifyEnabled(page)) return;
    // Click at most once every ~8s: clicking mid-verification resets it.
    if (Date.now() - lastClick > 8000) {
      const cf = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
      if (cf) {
        try {
          const cb = cf.locator('input[type="checkbox"]').first();
          if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
            await cb.click({ timeout: 2000 });
          } else {
            await cf.locator('body').click({ position: { x: 30, y: 30 }, timeout: 2000 });
          }
          lastClick = Date.now();
          clicks++;
          console.log(`  [${tag}] Clicked Turnstile (attempt ${clicks})`);
        } catch {}
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new TurnstileError('Turnstile not solved before timeout');
}

// Solve the phone-page Turnstile. Returns 'capsolver' | 'click' (method used).
async function ensureTurnstile(page, tag) {
  if (await verifyEnabled(page)) return 'already';

  if (!capsolverDisabled && cfg.CAPSOLVER_KEY) {
    try {
      const siteKey = await extractSiteKey(page);
      if (siteKey) {
        console.log(`  [${tag}] Solving Turnstile via CapSolver (sitekey ${siteKey.slice(0, 12)}...)...`);
        const solution = await capsolverSolve({
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: page.url(),
          websiteKey: siteKey,
        }, tag);
        const token = solution && solution.token;
        if (!token) throw new TurnstileError(`capsolver returned no token: ${JSON.stringify(solution)}`);

        // The solve often finishes BEFORE the app has mounted its widget.
        // Injecting then is worse than useless: with an empty registry we'd
        // call window.turnstileCallback, which on Seated is the api.js
        // ONLOAD/render kickoff (re-renders, never sets the token). Wait for
        // the app's render to be captured first.
        const regDeadline = Date.now() + 20000;
        while (Date.now() < regDeadline) {
          const n = await page.evaluate(() => (window.__tsCallbacks || []).length).catch(() => 0);
          if (n > 0) break;
          await page.waitForTimeout(500);
        }

        // Inject, then give Verify up to 15s to enable; retry the injection
        // once (covers any residual mount race) before declaring failure.
        for (let round = 1; round <= 2; round++) {
          const fired = await injectToken(page, token);
          console.log(`  [${tag}] Turnstile token injected (round ${round}, callback ${fired ? 'fired' : 'NOT found'})`);
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            if (await verifyEnabled(page)) return 'capsolver';
            await page.waitForTimeout(500);
          }
        }
        console.log(`  [${tag}] Verify still disabled after token injection - falling back to click`);
      }
    } catch (err) {
      console.error(`  [${tag}] CapSolver path failed (${err.message}) - falling back to click`);
    }
  }

  await clickFallback(page, tag);
  return 'click';
}

module.exports = { ensureTurnstile, verifyEnabled, extractSiteKey, injectToken, HOOK_SCRIPT, TurnstileError };
