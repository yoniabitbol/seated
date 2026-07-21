const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

const SMSPOOL_KEY = 'FseOMNf1VXHO0y9tmOnzS61rO7BXxK8f';
const SMSPOOL_SERVICE = '810';
const SMSPOOL_COUNTRY = '1';

// 5sim provider config (https://5sim.net/v1). Auth is a JWT bearer token.
const FIVESIM_KEY = 'eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTIzNzc3NDYsImlhdCI6MTc4MDg0MTc0NiwicmF5IjoiOWQ3YzRmNzA4NDE1ZTVkNTViYzI3YmJjYmUxNzljNmMiLCJzdWIiOjQxNzg3NTd9.BF_Bqn4Xhi0vgUYNgc_xAmBYc3kUpdrt-4H0JJ45Znf35MIRANDj4T8T8jciTF-NLoIy2kCJ8XpGF-aPcYOmUfIiGdsu4l2pef9y65S2Xo_xTWqDCgOG3FfB2x9JbnGor2GBjQpthxF5tYhz6-KYPelkOgRv3sP4VsR-jjNkX6VPrZh62S4veibqg-NzMG67U6Q0jyfC-lJNvnMDnMvrA1A3EOEMRDksE44JX9qEfHdxCoTXbYxHRLPtYjvbjn0XA9JVA2fkSu--QNT7Ju6IZlyHeWWETu8WvrGgp4w_UUd_XO0UyJZkgVJfZ_YttR1TI3NadmSiejykIvbI-yGABw';
const FIVESIM_COUNTRY = 'usa';
const FIVESIM_OPERATOR = 'any';
const FIVESIM_PRODUCT = 'seated';

// Which SMS provider to use: 'smspool' or '5sim'. Set from the startup dialog.
let PROVIDER = 'smspool';

let CONCURRENCY = 10;
let USES_PER_NUMBER = 1;
const TASK_TIMEOUT_MS = 600000;

// ── Events: emails.txt is split sequentially across these in order.
// First `count` emails → first event, next `count` → second event, etc.
// Each event tracks its own progress in completed-<eventId>.txt, so reruns resume.
// const EVENTS = [
//   { name: '1',              url: 'https://go.seated.com/waitlist/eef1df7f-2006-40c4-82df-2a5adb852c89/info', count: 100 },
//   { name: '2',              url: 'https://go.seated.com/waitlist/96ec4fdc-cb80-46a8-8b4c-101c72819c27/info', count: 100 },
//   { name: '3',              url: 'https://go.seated.com/waitlist/8bf8a239-eff2-4696-8106-dde262a56408/info', count: 400 },
//   { name: '4',              url: 'https://go.seated.com/waitlist/b0451655-f085-45b5-a194-650919017412/info', count: 400 },

// ];

const EVENTS = [
  { name: '1',              url: 'https://go.seated.com/event-reminders/440f4b5e-b9ef-42c8-a670-1e955347232e/info', count: 100 }
  // { name: '2',              url: 'https://go.seated.com/waitlist/96ec4fdc-cb80-46a8-8b4c-101c72819c27/info', count: 100 },
  // { name: '3',              url: 'https://go.seated.com/waitlist/8bf8a239-eff2-4696-8106-dde262a56408/info', count: 400 },
  // { name: '4',              url: 'https://go.seated.com/waitlist/b0451655-f085-45b5-a194-650919017412/info', count: 400 },

];

function eventId(url) { return url.match(/\/([a-f0-9-]{36})\//)?.[1] || 'default'; }
function completedFileFor(url) { return path.join(__dirname, `completed-${eventId(url)}.txt`); }

// ── Utilities ──

function loadLines(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
}
function randomFrom(lines) { return lines[Math.floor(Math.random() * lines.length)]; }
function loadCompleted(completedFile) {
  if (!fs.existsSync(completedFile)) return new Set();
  return new Set(fs.readFileSync(completedFile, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean));
}
function markCompleted(completedFile, email) { fs.appendFileSync(completedFile, email + '\n'); }
function loadProxy() {
  const lines = loadLines('isp.txt');
  const raw = randomFrom(lines);
  const p = raw.split(':');
  return { server: `http://${p[0]}:${p[1]}`, username: p[2], password: p[3] };
}

// Retry config (kept out of the protected constants block above).
const MAX_ATTEMPTS = 3;            // attempts per email before giving up
const ATTEMPT_TIMEOUT_MS = 300000; // 5 min cap per attempt (browser is killed on timeout)

// Run `promise` but reject if it doesn't settle within `ms`. The caller is
// responsible for cleanup (killing the browser) so a hung step never leaks.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── SMSPool API (all calls wrapped with retry + timeout) ──

async function fetchWithTimeout(url, timeoutMs = 15000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fivesimHeaders() {
  return { Authorization: `Bearer ${FIVESIM_KEY}`, Accept: 'application/json' };
}

async function orderSmsNumber(tag, retries = 3) {
  const isFivesim = PROVIDER === '5sim';
  const url = isFivesim
    ? `https://5sim.net/v1/user/buy/activation/${FIVESIM_COUNTRY}/${FIVESIM_OPERATOR}/${FIVESIM_PRODUCT}`
    : `https://api.smspool.net/purchase/sms?key=${SMSPOOL_KEY}&country=${SMSPOOL_COUNTRY}&service=${SMSPOOL_SERVICE}&max_price=0.14`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const data = await fetchWithTimeout(url, 15000, isFivesim ? fivesimHeaders() : {});
      if (isFivesim) {
        if (data && data.id && data.phone) {
          console.log(`  [${tag}] Number: ${data.phone} (${data.id})`);
          return { phone: data.phone, orderId: data.id };
        }
        console.error(`  [${tag}] 5sim order attempt ${attempt}: ${JSON.stringify(data)}`);
      } else {
        if (data.success === 1) {
          console.log(`  [${tag}] Number: ${data.phonenumber} (${data.order_id})`);
          return { phone: data.phonenumber, orderId: data.order_id };
        }
        console.error(`  [${tag}] SMSPool order attempt ${attempt}: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.error(`  [${tag}] ${isFivesim ? '5sim' : 'SMSPool'} order attempt ${attempt} network error: ${err.message}`);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`${isFivesim ? '5sim' : 'SMSPool'} order failed after retries`);
}

async function cancelSmsOrder(orderId, tag) {
  try {
    if (PROVIDER === '5sim') {
      await fetchWithTimeout(`https://5sim.net/v1/user/cancel/${orderId}`, 15000, fivesimHeaders());
    } else {
      await fetchWithTimeout(`https://api.smspool.net/sms/cancel?key=${SMSPOOL_KEY}&orderid=${orderId}`);
    }
  } catch (err) {
    console.error(`  [${tag}] Cancel order ${orderId} failed: ${err.message}`);
  }
}

async function pollForCode(orderId, tag, attempts, previousCodes = []) {
  const isFivesim = PROVIDER === '5sim';
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      if (isFivesim) {
        const data = await fetchWithTimeout(`https://5sim.net/v1/user/check/${orderId}`, 15000, fivesimHeaders());
        if (data && Array.isArray(data.sms) && data.sms.length) {
          const last = data.sms[data.sms.length - 1];
          const code = last.code || (last.text || '').match(/(\d{4,6})/)?.[1] || '';
          if (!code || previousCodes.includes(code)) continue;
          console.log(`  [${tag}] SMS code: ${code}`);
          return code;
        }
      } else {
        const data = await fetchWithTimeout(`https://api.smspool.net/sms/check?key=${SMSPOOL_KEY}&orderid=${orderId}`);
        if (data.status === 3 || data.sms) {
          const fullSms = data.sms || data.full_sms || '';
          const match = fullSms.match(/(\d{4,6})/);
          const code = match ? match[1] : fullSms;
          if (previousCodes.includes(code)) continue;
          console.log(`  [${tag}] SMS code: ${code}`);
          return code;
        }
      }
    } catch {}
  }
  return null;
}

// ── Browser helpers ──

async function killBrowser(browser, tag) {
  if (!browser) return;
  try {
    await Promise.race([
      browser.close(),
      new Promise(r => setTimeout(r, 5000)),
    ]);
  } catch {}
  try { browser.process()?.kill('SIGKILL'); } catch {}
  console.log(`  [${tag}] Browser killed`);
}

async function launchBrowser(proxy, tag) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', `--proxy-server=${proxy.server}`],
    });
    const contextOpts = {};
    if (proxy.username) contextOpts.httpCredentials = { username: proxy.username, password: proxy.password };
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    return { browser, page };
  } catch (err) {
    if (browser) await killBrowser(browser, tag);
    throw new Error(`Browser launch failed: ${err.message}`);
  }
}

// ── Step 1: Fill personal info and navigate to phone page ──

async function step1_fillInfo(page, email, formUrl, firstNames, lastNames, postalCodes, tag) {
  const firstName = randomFrom(firstNames);
  const lastName = randomFrom(lastNames);
  const postalCode = randomFrom(postalCodes);

  console.log(`  [${tag}] ${firstName} ${lastName} | ${email} | ${postalCode}`);

  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1500);

  const inputs = await page.$$('input');
  if (inputs.length < 4) throw new Error(`Expected 4 inputs, found ${inputs.length}`);

  await inputs[0].fill(firstName);
  await inputs[1].fill(lastName);
  await inputs[2].fill(email);
  await inputs[3].fill(postalCode);

  await page.click('button[type="submit"]');

  // Try to reach /phone, handle checkbox validation
  try {
    await page.waitForURL('**/phone', { timeout: 15000 });
    return;
  } catch {}

  // Check what went wrong
  const bodyText = await page.innerText('body').catch(() => '');

  if (bodyText.includes('must confirm your age') || bodyText.includes('Not a valid')) {
    console.log(`  [${tag}] Validation error, toggling checkboxes...`);
    const pointers = await page.$$('div.pointer');
    for (const p of pointers) {
      const text = (await p.innerText()).trim();
      if (text === '') { await p.click(); await page.waitForTimeout(200); }
    }
    await page.click('button[type="submit"]');
    await page.waitForURL('**/phone', { timeout: 15000 });
    return;
  }

  throw new Error(`Stuck on step 1: ${bodyText.substring(0, 150)}`);
}

// Returns true once the "Verify" button is enabled (Turnstile passed).
// NOTE: the phone page also has an unrelated, always-enabled "Next" submit button,
// so we must gate specifically on the Verify button's text — not just any
// non-disabled submit, or we'd false-positive and skip solving Turnstile.
async function submitEnabled(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
    const verify = btns.filter(b => (b.innerText || '').trim().toLowerCase() === 'verify');
    return verify.length > 0 && verify.some(b => !b.disabled);
  }).catch(() => false);
}

// Cloudflare Turnstile renders as an interactive checkbox that must be clicked.
// Its iframe is NESTED (the outer <iframe> has no src; the real challenge UI is
// a child frame whose URL is on challenges.cloudflare.com) and the checkbox lives
// in shadow DOM, so neither a `src`-based selector nor a checkbox selector works.
// What does work: grab the cloudflare frame from the frame tree and click its body
// near the top-left, where the checkbox sits. We poll until the submit button
// enables (auto-mode passes on its own; interactive mode needs the click).
async function solveTurnstile(page, tag, timeoutMs = 120000) {
  console.log(`  [${tag}] Waiting for Turnstile...`);
  const deadline = Date.now() + timeoutMs;
  let lastClick = 0;
  let clicks = 0;

  while (Date.now() < deadline) {
    if (await submitEnabled(page)) return;

    // Click only once every ~8s. Turnstile takes a few seconds to verify after a
    // click; clicking again mid-verification resets it, so it never completes.
    // Between clicks we just poll for the button to enable.
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

  throw new Error('Turnstile not solved before timeout');
}

// ── Step 2: Enter phone, solve captcha, click verify ──

async function step2_phone(page, phoneDigits, tag) {
  const phoneInput = await page.waitForSelector('input[type="tel"]', { timeout: 15000 });
  // All events are US, so the form already defaults to a US (+1) country code.
  await phoneInput.fill('');
  await phoneInput.fill(phoneDigits);

  await solveTurnstile(page, tag);

  // Click the Verify button specifically (not the unrelated, always-enabled "Next").
  await page.locator('button[type="submit"]:has-text("Verify"):not([disabled])').first().click({ timeout: 10000 });
  await page.waitForTimeout(3000);

  // Check for "Issue validating number" error
  const bodyText = await page.innerText('body').catch(() => '');
  if (bodyText.includes('Issue validating')) {
    throw new Error('Phone number rejected by Seated');
  }

}

// ── Step 3: Enter SMS code and submit ──

async function step3_enterCode(page, smsCode, tag) {
  await page.waitForTimeout(2000);
  const codeInputs = await page.$$('input');
  const visibleInputs = [];
  for (const inp of codeInputs) {
    const type = await inp.getAttribute('type');
    if (type !== 'hidden') visibleInputs.push(inp);
  }

  if (visibleInputs.length === 0) throw new Error('No code input found');

  if (visibleInputs.length === 1) {
    await visibleInputs[0].fill(smsCode);
  } else {
    for (let i = 0; i < Math.min(smsCode.length, visibleInputs.length); i++) {
      await visibleInputs[i].fill(smsCode[i]);
    }
  }

  try { await page.locator('button[type="submit"]').first().click({ timeout: 5000 }); } catch {}
  await page.waitForTimeout(3000);

  // Handle optional consent/preferences page that sometimes appears after SMS code
  const prefsBody = await page.innerText('body').catch(() => '');
  if (prefsBody.includes('Confirm your preferences') || prefsBody.includes('confirm your preferences')) {
    console.log(`  [${tag}] Preferences page — checking age box...`);
    const ageLocator = page.locator(':text("I confirm that I am 13")').first();
    const ageVisible = await ageLocator.isVisible().catch(() => false);
    if (ageVisible) {
      await ageLocator.click();
      await page.waitForTimeout(200);
    } else {
      const pointers = await page.$$('div.pointer');
      if (pointers.length > 0) { await pointers[0].click(); await page.waitForTimeout(200); }
    }
    const confirmBtn = page.locator('button:text("Confirm")').first();
    const confirmVisible = await confirmBtn.isVisible().catch(() => false);
    if (confirmVisible) { await confirmBtn.click(); } else { await page.click('button[type="submit"]'); }
    await page.waitForTimeout(1500);
  }

  // Handle optional quantity + price pages that can appear after SMS code.
  // Defaults are already selected — just click "Next" on each.
  for (let i = 0; i < 4; i++) {
    const body = await page.innerText('body').catch(() => '');
    const isQuantityPage = body.includes('How many tickets are you looking to buy');
    const isPricePage = body.includes('How much are you willing to spend per ticket');
    if (!isQuantityPage && !isPricePage) break;

    const label = isQuantityPage ? 'Quantity' : 'Price';
    console.log(`  [${tag}] ${label} page — clicking Next (default selected)...`);

    const nextBtn = page.locator('button:has-text("Next")').first();
    const nextVisible = await nextBtn.isVisible().catch(() => false);
    if (nextVisible) { await nextBtn.click(); } else { await page.click('button[type="submit"]'); }
    await page.waitForTimeout(1500);
  }
}

// ── Process ONE email end-to-end, retrying up to MAX_ATTEMPTS times. ──
// Every attempt gets a fresh proxy, a fresh SMS number, and a fresh browser,
// so a bad proxy / dead number / crashed browser on one try doesn't doom the email.
// Returns true on success, false only after all attempts are exhausted.

async function processEmail(email, formUrl, completedFile, firstNames, lastNames, postalCodes, tag) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const aTag = `${tag} a${attempt}/${MAX_ATTEMPTS}`;
    const proxy = loadProxy();
    let browser = null;
    let orderId = null;

    try {
      const order = await orderSmsNumber(aTag);
      orderId = order.orderId;
      const phoneDigits = order.phone.toString().replace(/^\+?1/, '');

      const launched = await launchBrowser(proxy, aTag);
      browser = launched.browser;
      const page = launched.page;

      await withTimeout((async () => {
        await step1_fillInfo(page, email, formUrl, firstNames, lastNames, postalCodes, aTag);
        await step2_phone(page, phoneDigits, aTag);
        const smsCode = await pollForCode(orderId, aTag, 20);
        if (!smsCode) throw new Error('No SMS received');
        await step3_enterCode(page, smsCode, aTag);
      })(), ATTEMPT_TIMEOUT_MS, 'attempt');

      markCompleted(completedFile, email);
      console.log(`${GREEN}  [${aTag}] SUCCESS — ${email}${RESET}`);
      return true;
    } catch (err) {
      console.error(`${RED}  [${aTag}] attempt failed — ${email}: ${err.message}${RESET}`);
      if (orderId) await cancelSmsOrder(orderId, aTag);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`  [${aTag}] Retrying in 5s with fresh number + proxy...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    } finally {
      await killBrowser(browser, aTag);
    }
  }

  console.error(`${RED}  [${tag}] GAVE UP after ${MAX_ATTEMPTS} attempts — ${email}${RESET}`);
  return false;
}

// ── Single global pool: keep CONCURRENCY emails in flight across ALL events. ──
// As soon as one email finishes (success or final failure), the next pending
// email from any event launches — the pool never drains between events.

function runGlobalPool(tasks, firstNames, lastNames, postalCodes) {
  return new Promise((resolve) => {
    let succeeded = 0;
    let failed = 0;
    let nextIdx = 0;
    const active = new Map();

    function launch() {
      if (nextIdx >= tasks.length) return;
      const idx = nextIdx++;
      const t = tasks[idx];
      const tag = `${idx + 1}/${tasks.length} ${t.eventShort}`;
      const entry = { tag, task: t, startTime: Date.now(), done: false, ok: false };
      active.set(idx, entry);

      console.log(`  >> Launched [${tag}] ${t.email} — ${active.size} active`);

      processEmail(t.email, t.event.url, t.completedFile, firstNames, lastNames, postalCodes, tag)
        .then((ok) => { entry.ok = ok; })
        .catch(() => { entry.ok = false; })
        .finally(() => { entry.done = true; });
    }

    const interval = setInterval(() => {
      const now = Date.now();

      // Reap finished + drop timed-out (backstop; processEmail self-bounds per attempt)
      for (const [idx, entry] of active) {
        if (entry.done) {
          if (entry.ok) succeeded++; else failed++;
          active.delete(idx);
        } else if (now - entry.startTime > TASK_TIMEOUT_MS) {
          console.log(`  [${entry.tag}] HARD KILL (timeout) — ${entry.task.email}`);
          failed++;
          active.delete(idx);
        }
      }

      // Top up to CONCURRENCY from the single global queue
      while (active.size < CONCURRENCY && nextIdx < tasks.length) launch();

      console.log(`  [POOL] ${active.size} active | ${GREEN}${succeeded} ok${RESET} | ${RED}${failed} fail${RESET} | ${tasks.length - nextIdx} queued`);

      if (active.size === 0 && nextIdx >= tasks.length) {
        clearInterval(interval);
        resolve({ succeeded, failed });
      }
    }, 2000);

    // Initial fill
    while (active.size < CONCURRENCY && nextIdx < tasks.length) launch();
  });
}

// ── MAIN: split emails across events, flatten into one global queue, run pool ──

(async () => {
  const provAnswer = await askQuestion('SMS provider? 1 = SMSPool, 2 = 5sim (default 1): ');
  PROVIDER = provAnswer.trim() === '2' ? '5sim' : 'smspool';
  console.log(`Using SMS provider: ${PROVIDER}`);

  const answer = await askQuestion('How many concurrent windows? (default 10): ');
  CONCURRENCY = parseInt(answer, 10) || 10;

  const allEmails = loadLines('emails.txt').filter(l => l.includes('@'));
  const uniqueEmails = [...new Set(allEmails)];

  // Slice the email list sequentially across events (first N → event 1, etc.).
  // Deterministic on emails.txt order, so reruns assign the same emails to the same events.
  const assignments = [];
  let cursor = 0;
  for (const event of EVENTS) {
    const slice = uniqueEmails.slice(cursor, cursor + event.count);
    cursor += event.count;
    assignments.push({ event, emails: slice });
  }
  const leftover = uniqueEmails.length - cursor;

  const firstNames = loadLines('firstNames.txt');
  const lastNames = loadLines('lastNames.txt');
  const postalCodes = loadLines('postalCodes.txt');

  // Build ONE global task list across all events, skipping already-completed emails.
  const tasks = [];
  let totalAssigned = 0;
  let totalDone = 0;
  for (const { event, emails } of assignments) {
    const completedFile = completedFileFor(event.url);
    const completed = loadCompleted(completedFile);
    totalAssigned += emails.length;
    for (const email of emails) {
      if (completed.has(email)) { totalDone++; continue; }
      tasks.push({ email, event, completedFile, eventShort: event.name });
    }
  }

  console.log(`Loaded ${uniqueEmails.length} unique emails across ${EVENTS.length} events.`);
  if (leftover > 0) console.log(`${RED}  Note: ${leftover} extra email(s) beyond the planned total are unassigned.${RESET}`);
  console.log(`Assigned: ${totalAssigned} | Already done: ${totalDone} | Pending: ${tasks.length}`);
  console.log(`Global pool: ${CONCURRENCY} concurrent | up to ${MAX_ATTEMPTS} attempts/email | fresh number+proxy per attempt\n`);

  if (!tasks.length) {
    console.log('Nothing pending across any event — done.');
    process.exit(0);
  }

  const { succeeded, failed } = await runGlobalPool(tasks, firstNames, lastNames, postalCodes);

  console.log(`\n=== ALL DONE === ${GREEN}${succeeded} ok${RESET}, ${RED}${failed} fail${RESET}`);
  console.log(`  Per-event progress is in completed-<eventId>.txt files.`);
  process.exit(0);
})();
