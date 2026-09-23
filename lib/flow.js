// The seated signup flow: info -> phone (+Turnstile) -> SMS code -> extras.
// Errors are classified (kind: 'proxy' | 'turnstile' | 'phone' | 'flow') so the
// runner can pick the right retry strategy and avoid wasting SMS orders.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { ensureTurnstile } = require('./captcha');
const { zipsForState, stateForAreaCode } = require('./zipdata');

class FlowError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Human-ish typing: click, then per-keypress delays.
async function humanType(locator, text) {
  await locator.click();
  await sleep(rand(150, 400));
  await locator.pressSequentially(text, { delay: rand(45, 110) });
}

async function humanClick(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (box) {
      await page.mouse.move(
        box.x + box.width / 2 + rand(-8, 8),
        box.y + box.height / 2 + rand(-5, 5),
        { steps: rand(4, 10) }
      );
      await sleep(rand(80, 250));
    }
  } catch {}
  await locator.click();
}

const bodyText = (page) => page.innerText('body').catch(() => '');

// ── Step 1: personal info -> /phone ──

async function step1(page, task, data, proxy, tag) {
  const firstName = randomFrom(data.firstNames);
  const lastName = randomFrom(data.lastNames);
  // Postal code consistent with the phone's area code when the event pins one
  // (user's choice wins), else with the proxy's geo state (falls back to full list).
  const areaState = task.areaCode ? stateForAreaCode(task.areaCode) : null;
  const state = areaState || (proxy.geo && proxy.geo.state);
  const postalCode = randomFrom(zipsForState(data.postalCodes, state));

  console.log(`  [${tag}] ${firstName} ${lastName} | ${task.email} | ${postalCode}${state ? ` (${state}${areaState ? ` via area ${task.areaCode}` : ''})` : ''}`);

  try {
    await page.goto(task.event.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    throw new FlowError('proxy', `navigation failed: ${String(err.message).slice(0, 120)}`);
  }

  await page.waitForSelector('input', { timeout: 20000 }).catch(() => null);
  const inputLoc = page.locator('input');
  const inputCount = await inputLoc.count();
  if (inputCount < 4) {
    const body = await bodyText(page);
    if (/signup window is now closed/i.test(body)) {
      throw new FlowError('closed', 'signup window is closed for this event');
    }
    throw new FlowError('flow', `expected 4 inputs, found ${inputCount}: ${body.substring(0, 120)}`);
  }
  await sleep(rand(800, 1800));

  await humanType(inputLoc.nth(0), firstName);
  await humanType(inputLoc.nth(1), lastName);
  await humanType(inputLoc.nth(2), task.email);
  await humanType(inputLoc.nth(3), postalCode);
  await sleep(rand(300, 800));

  await humanClick(page, page.locator('button[type="submit"]').first());

  try {
    await page.waitForURL('**/phone', { timeout: 20000 });
    return { firstName, lastName, postalCode };
  } catch {}

  // Validation hiccup (age checkbox etc.) -> toggle empty checkboxes, resubmit.
  const body = await bodyText(page);
  if (body.includes('must confirm your age') || body.includes('Not a valid')) {
    console.log(`  [${tag}] validation error, toggling checkboxes...`);
    const pointers = page.locator('div.pointer');
    const pCount = await pointers.count();
    for (let i = 0; i < pCount; i++) {
      const text = (await pointers.nth(i).innerText()).trim();
      // Bare checkbox divs have empty text; the age-confirm checkbox on some
      // events is labeled inline ("I confirm that I am 13...") inside the
      // pointer itself - tick either form.
      if (text === '' || /13 years? of age/i.test(text)) { await pointers.nth(i).click(); await sleep(rand(150, 350)); }
    }
    await humanClick(page, page.locator('button[type="submit"]').first());
    try {
      await page.waitForURL('**/phone', { timeout: 20000 });
      return { firstName, lastName, postalCode };
    } catch {}
  }

  throw new FlowError('flow', `stuck on step 1: ${(await bodyText(page)).substring(0, 150)}`);
}

// ── Step 2: phone number + Turnstile + Verify ──
// Also captures the backend verdict on POST api.seated.com/oauth/verify - a
// silent "no SMS ever arrives" is indistinguishable from a rejection without it.

async function step2(page, phoneDigits, tag) {
  // Return an existing verdict if one was already captured (retry within same page).
  const existing = page.__seatedVerify;
  if (existing && existing.status !== null) {
    console.log(`  [${tag}] /oauth/verify already captured: ${existing.status}${existing.body ? ` ${existing.body.slice(0, 120)}` : ''}`);
    return { method: 'already', verifyStatus: existing.status, verifyBody: existing.body };
  }
  const verdict = page.__seatedVerify || (page.__seatedVerify = { status: null, body: null });
  if (!page.__seatedVerifyHooked) {
    page.__seatedVerifyHooked = true;
    page.on('response', async (res) => {
      try {
        if (res.url().includes('api.seated.com') && res.url().includes('/oauth/verify')) {
          verdict.status = res.status();
          verdict.body = (await res.text().catch(() => '')).slice(0, 300);
        }
      } catch {}
    });
  }

  const phoneInput = page.locator('input[type="tel"]').first();
  await phoneInput.waitFor({ state: 'visible', timeout: 20000 });
  await humanType(phoneInput, phoneDigits);
  await sleep(rand(400, 900));

  const method = await ensureTurnstile(page, tag); // throws FlowError-kind 'turnstile'

  await humanClick(page, page.locator('button[type="submit"]:has-text("Verify"):not([disabled])').first());

  // Wait for the backend's verdict (or a visible validation error).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && verdict.status === null) {
    const body = await bodyText(page);
    if (body.includes('Issue validating')) {
      throw new FlowError('phone', 'phone number rejected by Seated (UI)');
    }
    await sleep(500);
  }

  if (verdict.status === null) {
    console.log(`  [${tag}] WARNING: no /oauth/verify call observed within 30s`);
    return { method, verifyStatus: null, verifyBody: null };
  }

  console.log(`  [${tag}] /oauth/verify -> ${verdict.status}${verdict.body ? ` ${verdict.body.slice(0, 120)}` : ''}`);
  if (verdict.status >= 400) {
    const isPhone = /phone|number|valid/i.test(verdict.body || '');
    throw new FlowError(isPhone ? 'phone' : 'verify',
      `backend rejected verify: ${verdict.status} ${(verdict.body || '').slice(0, 150)}`);
  }
  return { method, verifyStatus: verdict.status, verifyBody: verdict.body };
}

// ── Step 3: SMS code + optional extras ──

async function step3(page, smsCode, tag) {
  await sleep(2000);
  const all = page.locator('input');
  const total = await all.count();
  const visibleInputs = [];
  for (let i = 0; i < total; i++) {
    const inp = all.nth(i);
    const type = await inp.getAttribute('type');
    if (type !== 'hidden' && await inp.isVisible().catch(() => false)) visibleInputs.push(inp);
  }
  if (visibleInputs.length === 0) throw new FlowError('flow', 'no code input found');

  if (visibleInputs.length === 1) {
    await humanType(visibleInputs[0], smsCode);
  } else {
    for (let i = 0; i < Math.min(smsCode.length, visibleInputs.length); i++) {
      await visibleInputs[i].pressSequentially(smsCode[i], { delay: rand(60, 130) });
    }
  }
  await sleep(rand(300, 700));
  try { await humanClick(page, page.locator('button[type="submit"]').first()); } catch {}
  await sleep(3000);

  // Optional consent/preferences page.
  let body = await bodyText(page);
  if (body.includes('Confirm your preferences') || body.includes('confirm your preferences')) {
    console.log(`  [${tag}] preferences page - checking age box...`);
    const ageLocator = page.locator(':text("I confirm that I am 13")').first();
    if (await ageLocator.isVisible().catch(() => false)) {
      await ageLocator.click();
      await sleep(200);
    } else {
      const pointers = page.locator('div.pointer');
      if (await pointers.count() > 0) { await pointers.first().click(); await sleep(200); }
    }
    const confirmBtn = page.locator('button:text("Confirm")').first();
    if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
    else await page.click('button[type="submit"]');
    await sleep(1500);
  }

  // Optional quantity + price pages (defaults selected - just click Next).
  for (let i = 0; i < 4; i++) {
    body = await bodyText(page);
    const isQuantityPage = body.includes('How many tickets are you looking to buy');
    const isPricePage = body.includes('How much are you willing to spend per ticket');
    if (!isQuantityPage && !isPricePage) break;
    console.log(`  [${tag}] ${isQuantityPage ? 'Quantity' : 'Price'} page - clicking Next...`);
    const nextBtn = page.locator('button:has-text("Next")').first();
    if (await nextBtn.isVisible().catch(() => false)) await nextBtn.click();
    else await page.click('button[type="submit"]');
    await sleep(1500);
  }
}

// ── Success audit: capture the terminal state so silent drops become visible.
// (Success is still defined as "flow completed", as before - this adds evidence.)
async function audit(page, task, tag) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const body = (await bodyText(page)).replace(/\s+/g, ' ').substring(0, 500);
  const stillOnPhone = url.includes('/phone');
  const errorText = /issue validating|invalid code|expired|try again/i.test(body);
  const verified = !stillOnPhone && !errorText;

  try {
    const safe = task.email.replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(cfg.OUT_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'final.png'), fullPage: true });
    fs.writeFileSync(path.join(dir, 'final.json'), JSON.stringify({
      email: task.email, event: task.event.url, url, title, verified, body, ts: new Date().toISOString(),
    }, null, 1));
  } catch {}

  if (!verified) console.log(`  [${tag}] WARNING: terminal state looks uncertain (url=${url.slice(0, 80)}) - check out/ audit`);
  return { verified, url, title };
}

async function errorShot(page, task, name) {
  try {
    if (!page) return;
    const safe = task.email.replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(cfg.OUT_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  } catch {}
}

// Pre-flight: is the event's signup form actually open? Probed once per event
// before any money is spent. Returns { open, detail }.
async function probeEvent(browserMgr, proxyPool, event, tag) {
  const id = (event.url.match(/\/([a-f0-9-]{36})\//) || [])[1] || 'default';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let proxy = null;
    let context = null;
    try {
      proxy = await proxyPool.acquire(`probe-${id}`, tag);
      context = await browserMgr.newContext(proxy);
      const page = await context.newPage();
      await page.goto(event.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(5000);
      const inputs = (await page.$$('input')).length;
      const body = (await bodyText(page)).replace(/\s+/g, ' ');
      if (inputs >= 4) return { open: true, detail: `form present (${inputs} inputs)` };
      return { open: false, detail: body.substring(0, 120) || 'no form' };
    } catch (err) {
      if (attempt === 2) return { open: null, detail: `probe failed: ${String(err.message).slice(0, 100)}` };
    } finally {
      if (proxy) proxyPool.release(proxy);
      await browserMgr.closeContext(context, tag);
    }
  }
  return { open: null, detail: 'probe inconclusive' };
}

module.exports = { step1, step2, step3, audit, errorShot, probeEvent, FlowError, sleep, rand };
