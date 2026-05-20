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
const FORM_URL = 'https://go.seated.com/event-reminders/88c8e073-5537-486a-bdb1-3733b89fd09f/info';
let CONCURRENCY = 10;
let USES_PER_NUMBER = 1;
const TASK_TIMEOUT_MS = 600000;
const COMPLETED_FILE = path.join(__dirname, 'completed.txt');

// ── Utilities ──

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

// ── SMSPool API (all calls wrapped with retry + timeout) ──

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function orderSmsNumber(tag, retries = 3) {
  const url = `https://api.smspool.net/purchase/sms?key=${SMSPOOL_KEY}&country=${SMSPOOL_COUNTRY}&service=${SMSPOOL_SERVICE}&max_price=0.12`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const data = await fetchWithTimeout(url);
      if (data.success === 1) {
        console.log(`  [${tag}] Number: ${data.phonenumber} (${data.order_id})`);
        return { phone: data.phonenumber, orderId: data.order_id };
      }
      console.error(`  [${tag}] SMSPool order attempt ${attempt}: ${JSON.stringify(data)}`);
    } catch (err) {
      console.error(`  [${tag}] SMSPool order attempt ${attempt} network error: ${err.message}`);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('SMSPool order failed after retries');
}

async function cancelSmsOrder(orderId, tag) {
  try {
    await fetchWithTimeout(`https://api.smspool.net/sms/cancel?key=${SMSPOOL_KEY}&orderid=${orderId}`);
  } catch (err) {
    console.error(`  [${tag}] Cancel order ${orderId} failed: ${err.message}`);
  }
}

async function resendSms(orderId, tag, lastResendTime = 0) {
  // SMSPool requires ~60s between resends
  const elapsed = Date.now() - lastResendTime;
  const waitNeeded = Math.max(0, 15000 - elapsed);
  if (waitNeeded > 0) {
    console.log(`  [${tag}] Waiting ${Math.ceil(waitNeeded / 1000)}s before resend...`);
    await new Promise(r => setTimeout(r, waitNeeded));
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchWithTimeout(`https://api.smspool.net/sms/resend?key=${SMSPOOL_KEY}&orderid=${orderId}`);
      if (data.success === 1) {
        console.log(`  [${tag}] Resend OK`);
        return true;
      }
      const msg = data.message || '';
      if (msg.includes('wait a minute')) {
        console.log(`  [${tag}] Resend rate limited, waiting 30s...`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      if (msg.includes('only re-send to a phonenumber that has received')) {
        console.log(`  [${tag}] Number never received first SMS — cannot resend`);
        return false;
      }
      console.log(`  [${tag}] Resend attempt ${attempt}: ${JSON.stringify(data)}`);
    } catch (err) {
      console.error(`  [${tag}] Resend attempt ${attempt} error: ${err.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

async function pollForCode(orderId, tag, attempts, previousCodes = []) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const data = await fetchWithTimeout(`https://api.smspool.net/sms/check?key=${SMSPOOL_KEY}&orderid=${orderId}`);
      if (data.status === 3 || data.sms) {
        const fullSms = data.sms || data.full_sms || '';
        const match = fullSms.match(/(\d{4,6})/);
        const code = match ? match[1] : fullSms;
        if (previousCodes.includes(code)) continue;
        console.log(`  [${tag}] SMS code: ${code}`);
        return code;
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

async function step1_fillInfo(page, email, firstNames, lastNames, postalCodes, tag) {
  const firstName = randomFrom(firstNames);
  const lastName = randomFrom(lastNames);
  const postalCode = randomFrom(postalCodes);

  console.log(`  [${tag}] ${firstName} ${lastName} | ${email} | ${postalCode}`);

  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

// ── Step 2: Enter phone, solve captcha, click verify ──

async function step2_phone(page, phoneDigits, tag) {
  const phoneInput = await page.waitForSelector('input[type="tel"]', { timeout: 15000 });
  await phoneInput.fill('');
  await phoneInput.fill(phoneDigits);

  console.log(`  [${tag}] Waiting for Turnstile...`);
  await page.waitForFunction(() => {
    const btns = document.querySelectorAll('button[type="submit"]');
    return Array.from(btns).some(b => !b.disabled);
  }, { timeout: 120000 });

  await page.locator('button[type="submit"]:not([disabled])').first().click({ timeout: 10000 });
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
}

// ── Run one email (steps 1-3) with an existing browser + number ──

async function runOneEmail(page, email, phoneDigits, orderId, firstNames, lastNames, postalCodes, tag, previousCodes) {
  // Step 1
  await step1_fillInfo(page, email, firstNames, lastNames, postalCodes, tag);

  // Step 2
  await step2_phone(page, phoneDigits, tag);

  // Step 3: poll for code
  const smsCode = await pollForCode(orderId, tag, 20, previousCodes);
  if (!smsCode) throw new Error('No SMS received');

  await step3_enterCode(page, smsCode, tag);

  markCompleted(email);
  console.log(`${GREEN}  [${tag}] SUCCESS — ${email}${RESET}`);
  return smsCode;
}

// ── Process a group of up to 3 emails with one phone number ──

async function processGroup(emails, firstNames, lastNames, postalCodes, groupTag) {
  const proxy = loadProxy();
  let browser = null;
  let orderId = null;
  const results = [];

  try {
    // Buy number
    const order = await orderSmsNumber(groupTag);
    orderId = order.orderId;
    const phoneDigits = order.phone.toString().replace(/^\+?1/, '');

    // Launch browser
    const launched = await launchBrowser(proxy, groupTag);
    browser = launched.browser;
    const page = launched.page;

    const usedCodes = [];
    let lastResendTime = 0;

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const tag = `${groupTag}:${i + 1}/${emails.length}`;

      // For 2nd and 3rd email, resend SMS to the same number
      if (i > 0) {
        console.log(`  [${tag}] Requesting resend...`);
        const resendOk = await resendSms(orderId, tag, lastResendTime);
        lastResendTime = Date.now();
        if (!resendOk) {
          console.log(`  [${tag}] Resend failed — buying new number for remaining emails`);
          await cancelSmsOrder(orderId, groupTag);
          try {
            const newOrder = await orderSmsNumber(tag);
            orderId = newOrder.orderId;
            const newDigits = newOrder.phone.toString().replace(/^\+?1/, '');
            usedCodes.length = 0;
            lastResendTime = 0;

            try {
              const code = await runOneEmail(page, email, newDigits, orderId, firstNames, lastNames, postalCodes, tag, usedCodes);
              usedCodes.push(code);
              results.push({ email, ok: true });
            } catch (err) {
              console.error(`${RED}  [${tag}] FAILED — ${email}: ${err.message}${RESET}`);
              results.push({ email, ok: false });
            }
            continue;
          } catch (err) {
            console.error(`  [${tag}] New number also failed: ${err.message}`);
            results.push({ email, ok: false });
            continue;
          }
        }
      }

      try {
        const code = await runOneEmail(page, email, phoneDigits, orderId, firstNames, lastNames, postalCodes, tag, usedCodes);
        usedCodes.push(code);
        results.push({ email, ok: true });
      } catch (err) {
        console.error(`${RED}  [${tag}] FAILED — ${email}: ${err.message}${RESET}`);
        results.push({ email, ok: false });

        // If step 1 or browser crashed, try to recover for remaining emails
        try {
          const currentUrl = page.url();
          if (!currentUrl || currentUrl === 'about:blank') throw new Error('page dead');
        } catch {
          console.log(`  [${tag}] Page is dead — cannot continue group`);
          for (let j = i + 1; j < emails.length; j++) {
            results.push({ email: emails[j], ok: false });
          }
          break;
        }
      }
    }

    await killBrowser(browser, groupTag);
    browser = null;
    return results;
  } catch (err) {
    console.error(`${RED}  [${groupTag}] GROUP FAILED: ${err.message}${RESET}`);
    // Mark all unprocessed emails as failed
    const processed = new Set(results.map(r => r.email));
    for (const email of emails) {
      if (!processed.has(email)) results.push({ email, ok: false });
    }
    if (orderId) await cancelSmsOrder(orderId, groupTag);
    await killBrowser(browser, groupTag);
    return results;
  }
}

// ── MAIN: polling-based concurrency manager ──

(async () => {
  const answer = await askQuestion('How many concurrent windows? (default 10): ');
  CONCURRENCY = parseInt(answer, 10) || 10;

  const reuseAnswer = await askQuestion('Reuse phone numbers? (y = reuse up to 3x, n = fresh number per email) [n]: ');
  USES_PER_NUMBER = reuseAnswer.toLowerCase() === 'y' ? 3 : 1;

  const allEmails = loadLines('emails.txt').filter(l => l.includes('@'));
  const uniqueEmails = [...new Set(allEmails)];
  const completed = loadCompleted();
  const pending = uniqueEmails.filter(e => !completed.has(e));

  console.log(`Total: ${uniqueEmails.length} | Done: ${completed.size} | Remaining: ${pending.length}`);
  console.log(`Concurrency: ${CONCURRENCY} groups | ${USES_PER_NUMBER} email${USES_PER_NUMBER > 1 ? 's' : ''}/number | US numbers only\n`);
  if (!pending.length) { console.log('All emails done!'); process.exit(0); }

  const groups = [];
  for (let i = 0; i < pending.length; i += USES_PER_NUMBER) {
    groups.push(pending.slice(i, i + USES_PER_NUMBER));
  }
  console.log(`  ${groups.length} groups to process\n`);

  const firstNames = loadLines('firstNames.txt');
  const lastNames = loadLines('lastNames.txt');
  const postalCodes = loadLines('postalCodes.txt');

  let succeeded = 0;
  let failed = 0;
  let nextGroupIdx = 0;

  const tasks = new Map();

  function launch() {
    if (nextGroupIdx >= groups.length) return;
    const idx = nextGroupIdx++;
    const group = groups[idx];
    const tag = `G${idx + 1}/${groups.length}`;
    const entry = { tag, group, startTime: Date.now(), done: false, results: null };
    tasks.set(idx, entry);

    console.log(`  >> Launched [${tag}] ${group.join(', ')} — ${tasks.size} active`);

    processGroup(group, firstNames, lastNames, postalCodes, tag)
      .then((results) => { entry.results = results; })
      .catch(() => { entry.results = group.map(e => ({ email: e, ok: false })); })
      .finally(() => { entry.done = true; });
  }

  const interval = setInterval(() => {
    const now = Date.now();

    // Reap finished + kill timed out
    for (const [idx, entry] of tasks) {
      if (entry.done) {
        for (const r of (entry.results || [])) {
          if (r.ok) succeeded++; else failed++;
        }
        tasks.delete(idx);
      } else if (now - entry.startTime > TASK_TIMEOUT_MS) {
        console.log(`  [${entry.tag}] HARD KILL (timeout) — ${entry.group.join(', ')}`);
        for (const e of entry.group) failed++;
        tasks.delete(idx);
      }
    }

    // Top up
    while (tasks.size < CONCURRENCY && nextGroupIdx < groups.length) {
      launch();
    }

    console.log(`  [POOL] ${tasks.size} active | ${GREEN}${succeeded} ok${RESET} | ${RED}${failed} fail${RESET} | ${groups.length - nextGroupIdx} groups queued`);

    if (tasks.size === 0 && nextGroupIdx >= groups.length) {
      clearInterval(interval);
      console.log(`\n=== ALL DONE === ${GREEN}${succeeded} ok${RESET}, ${RED}${failed} fail${RESET}`);
      console.log(`  See completed.txt for the list.`);
      process.exit(0);
    }
  }, 2000);

  // Initial launch
  while (tasks.size < CONCURRENCY && nextGroupIdx < groups.length) {
    launch();
  }
})();
