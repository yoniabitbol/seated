const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SMSPOOL_KEY = '0y5tl6qrvWcWQluvf9R8C5SSFKhqm2Fq';
const SMSPOOL_SERVICE = '810';
const SMSPOOL_COUNTRY = '1';
const FORM_URL = 'https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info';
const CONCURRENCY = 10;
const TASK_TIMEOUT_MS = 240000; // 4 min hard kill
const COMPLETED_FILE = path.join(__dirname, 'completed.txt');

function loadLines(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
}
function randomFrom(lines) { return lines[Math.floor(Math.random() * lines.length)]; }
function loadCompleted() {
  if (!fs.existsSync(COMPLETED_FILE)) return new Set();
  return new Set(loadLines('completed.txt'));
}
function markCompleted(email) { fs.appendFileSync(COMPLETED_FILE, email + '\n'); }
function loadProxy() {
  const lines = loadLines('isp.txt');
  const raw = randomFrom(lines);
  const p = raw.split(':');
  return { server: `http://${p[0]}:${p[1]}`, username: p[2], password: p[3] };
}

async function orderSmsNumber(tag) {
  const url = `https://api.smspool.net/purchase/sms?key=${SMSPOOL_KEY}&country=${SMSPOOL_COUNTRY}&service=${SMSPOOL_SERVICE}&max_price=0.12`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.success !== 1) throw new Error(`SMSPool order failed: ${JSON.stringify(data)}`);
  console.log(`  [${tag}] Number: ${data.phonenumber} (${data.order_id})`);
  return { phone: data.phonenumber, orderId: data.order_id };
}

async function cancelSmsOrder(orderId) {
  try { await fetch(`https://api.smspool.net/sms/cancel?key=${SMSPOOL_KEY}&orderid=${orderId}`); } catch {}
}

async function pollForCode(orderId, tag, attempts) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`https://api.smspool.net/sms/check?key=${SMSPOOL_KEY}&orderid=${orderId}`);
      const data = await res.json();
      if (data.status === 3 || data.sms) {
        const fullSms = data.sms || data.full_sms || '';
        const match = fullSms.match(/(\d{4,6})/);
        const code = match ? match[1] : fullSms;
        console.log(`  [${tag}] SMS code: ${code}`);
        return code;
      }
    } catch {}
  }
  return null;
}

async function processEmail(email, firstNames, lastNames, postalCodes, tag) {
  const firstName = randomFrom(firstNames);
  const lastName = randomFrom(lastNames);
  const postalCode = randomFrom(postalCodes);
  const proxy = loadProxy();

  console.log(`  [${tag}] ${firstName} ${lastName} | ${email} | ${postalCode}`);

  let browser;
  try {
    const { phone, orderId } = await orderSmsNumber(tag);
    const phoneDigits = phone.toString().replace(/^\+?1/, '');

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

    // STEP 1
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const inputs = await page.$$('input');
    await inputs[0].fill(firstName);
    await inputs[1].fill(lastName);
    await inputs[2].fill(email);
    await inputs[3].fill(postalCode);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL('**/phone', { timeout: 15000 });
    } catch {
      const pointers = await page.$$('div.pointer');
      for (const p of pointers) {
        const text = (await p.innerText()).trim();
        if (text === '') { await p.click(); await page.waitForTimeout(200); }
      }
      await page.click('button[type="submit"]');
      await page.waitForURL('**/phone', { timeout: 15000 });
    }

    // STEP 2+3: Phone verify with retry
    let smsCode = null;
    let currentOrderId = orderId;
    let currentPhoneDigits = phoneDigits;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await cancelSmsOrder(currentOrderId);
        const newOrder = await orderSmsNumber(tag);
        currentOrderId = newOrder.orderId;
        currentPhoneDigits = newOrder.phone.toString().replace(/^\+?1/, '');
        console.log(`  [${tag}] Retry #${attempt + 1}: ${currentPhoneDigits}`);
        await page.goto(FORM_URL.replace('/info', '/phone'), { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
      }

      const phoneInput = await page.waitForSelector('input[type="tel"]', { timeout: 10000 });
      await phoneInput.fill('');
      await phoneInput.fill(currentPhoneDigits);
      await page.waitForFunction(() => {
        const btns = document.querySelectorAll('button[type="submit"]');
        return Array.from(btns).some(b => !b.disabled);
      }, { timeout: 120000 });
      await page.locator('button[type="submit"]:not([disabled])').first().click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      smsCode = await pollForCode(currentOrderId, tag, 15);
      if (smsCode) break;
      console.log(`  [${tag}] No SMS attempt ${attempt + 1}`);
    }

    if (!smsCode) { await cancelSmsOrder(currentOrderId); throw new Error('No SMS after 3 numbers'); }

    await page.waitForTimeout(2000);
    const codeInputs = await page.$$('input');
    const visibleInputs = [];
    for (const inp of codeInputs) {
      const type = await inp.getAttribute('type');
      if (type !== 'hidden') visibleInputs.push(inp);
    }
    if (visibleInputs.length === 1) {
      await visibleInputs[0].fill(smsCode);
    } else if (visibleInputs.length > 1) {
      for (let i = 0; i < Math.min(smsCode.length, visibleInputs.length); i++) {
        await visibleInputs[i].fill(smsCode[i]);
      }
    }
    try { await page.locator('button[type="submit"]').first().click({ timeout: 5000 }); } catch {}

    markCompleted(email);
    console.log(`  [${tag}] SUCCESS — ${email}`);
    try { await page.waitForURL((url) => !url.href.includes('/phone'), { timeout: 10000 }); } catch {}
    await browser.close();
    return true;
  } catch (err) {
    console.error(`  [${tag}] FAILED — ${email}: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch {
        try { browser.process()?.kill('SIGKILL'); } catch {}
      }
    }
    return false;
  }
}

// ── MAIN: polling-based concurrency manager ──

(async () => {
  const allEmails = loadLines('emails.txt').filter(l => l.includes('@'));
  const uniqueEmails = [...new Set(allEmails)];
  const completed = loadCompleted();
  const pending = uniqueEmails.filter(e => !completed.has(e));

  console.log(`Total: ${uniqueEmails.length} | Done: ${completed.size} | Remaining: ${pending.length} | Concurrency: ${CONCURRENCY}\n`);
  if (!pending.length) { console.log('All emails done!'); process.exit(0); }

  const firstNames = loadLines('firstNames.txt');
  const lastNames = loadLines('lastNames.txt');
  const postalCodes = loadLines('postalCodes.txt');

  let succeeded = 0;
  let failed = 0;
  let nextIdx = 0;

  // Each task: { email, tag, startTime, done: bool, result: bool|null }
  const tasks = new Map();

  function launch() {
    if (nextIdx >= pending.length) return;
    const idx = nextIdx++;
    const email = pending[idx];
    const tag = `${idx + 1}/${pending.length}`;
    const entry = { email, tag, startTime: Date.now(), done: false, result: null };
    tasks.set(email, entry);

    console.log(`  >> Launched [${tag}] ${email} — ${tasks.size} tracked`);

    processEmail(email, firstNames, lastNames, postalCodes, tag)
      .then((ok) => { entry.result = ok; })
      .catch(() => { entry.result = false; })
      .finally(() => { entry.done = true; });
  }

  // Poll every 2 seconds: reap finished tasks, kill stale ones, top up
  const interval = setInterval(() => {
    const now = Date.now();

    // Reap finished tasks
    for (const [email, entry] of tasks) {
      if (entry.done) {
        if (entry.result) succeeded++; else failed++;
        tasks.delete(email);
      } else if (now - entry.startTime > TASK_TIMEOUT_MS) {
        console.log(`  [${entry.tag}] HARD KILL (timeout) — ${email}`);
        failed++;
        tasks.delete(email);
      }
    }

    // Top up to CONCURRENCY
    while (tasks.size < CONCURRENCY && nextIdx < pending.length) {
      launch();
    }

    console.log(`  [POOL] ${tasks.size} active | ${succeeded} ok | ${failed} fail | ${pending.length - nextIdx} queued`);

    // Done?
    if (tasks.size === 0 && nextIdx >= pending.length) {
      clearInterval(interval);
      console.log(`\n=== ALL DONE === ${succeeded} ok, ${failed} fail`);
      console.log(`  See completed.txt for the list.`);
      process.exit(0);
    }
  }, 2000);

  // Initial launch
  while (tasks.size < CONCURRENCY && nextIdx < pending.length) {
    launch();
  }
})();
