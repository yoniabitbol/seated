const { chromium } = require('playwright');

const CONFIG = {
  firstName: 'Haiya',
  lastName: 'Krespine',
  email: 'haiyakrespine@gmail.com',
  postalCode: 'H3X1Y9',
  phone: '5142976235',
  formUrl: 'https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info',
};

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Capture ALL network requests/responses on the phone page
  page.on('request', (req) => {
    if (req.method() === 'POST' && !req.url().includes('challenge-platform') && !req.url().includes('posthog') && !req.url().includes('flags')) {
      console.log(`\n>>> REQUEST: ${req.method()} ${req.url()}`);
      console.log('  Headers:', JSON.stringify(req.headers(), null, 2));
      if (req.postData()) console.log('  Body:', req.postData().substring(0, 2000));
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('api.seated.com') || (url.includes('prelude') && !url.includes('challenge'))) {
      try {
        const body = await res.text();
        console.log(`\n<<< RESPONSE: ${res.status()} ${res.request().method()} ${url}`);
        console.log('  Body:', body.substring(0, 2000));
      } catch (e) {}
    }
  });

  // Step 1
  await page.goto(CONFIG.formUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1000);

  const inputs = await page.$$('input');
  await inputs[0].fill(CONFIG.firstName);
  await inputs[1].fill(CONFIG.lastName);
  await inputs[2].fill(CONFIG.email);
  await inputs[3].fill(CONFIG.postalCode);

  const cbs = await page.$$('div.pointer');
  for (const cb of cbs) { await cb.click(); await page.waitForTimeout(200); }

  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  console.log('\n=== ON PHONE PAGE ===');

  // Debug: what does the country selector area look like?
  const countryBtn = await page.$('[data-test-show-country-selector]');
  if (countryBtn) {
    const countryText = await countryBtn.innerText();
    console.log('Current country button text:', countryText);

    // Click to open country selector
    await countryBtn.click();
    await page.waitForTimeout(1000);

    // Screenshot the open dropdown
    await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/country-dropdown.png', fullPage: true });

    // Debug: what options are visible?
    const visibleText = await page.innerText('body');
    // Look for country-related text
    const lines = visibleText.split('\n').filter(l => l.trim().length > 0);
    console.log('\nVisible text after clicking country:');
    lines.slice(0, 40).forEach(l => console.log('  ', l));

    // Try to find and click Canada
    const canadaEl = page.locator('text=Canada').first();
    const canadaVisible = await canadaEl.isVisible().catch(() => false);
    console.log('\nCanada option visible:', canadaVisible);

    if (canadaVisible) {
      await canadaEl.click();
      await page.waitForTimeout(500);
    } else {
      // Try searching
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], input[placeholder*="Search" i]');
      if (searchInput) {
        console.log('Found search input in dropdown');
        await searchInput.fill('Canada');
        await page.waitForTimeout(500);
        await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/country-search.png', fullPage: true });
      }
      // Close the dropdown by pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }

  // Fill phone
  const phoneInput = await page.$('input[type="tel"][data-test-phone-number]');
  await phoneInput.fill(CONFIG.phone);
  console.log('Phone entered.');

  // Check country after selection
  const countryBtnAfter = await page.$('[data-test-show-country-selector]');
  if (countryBtnAfter) {
    const flagImg = await page.$('[data-test-show-country-selector] img');
    if (flagImg) {
      const src = await flagImg.getAttribute('src');
      const alt = await flagImg.getAttribute('alt');
      console.log(`Country flag: src=${src} alt=${alt}`);
    }
  }

  console.log('\nWaiting for Turnstile... (click it if needed)');

  await page.waitForFunction(() => {
    const btns = document.querySelectorAll('button[type="submit"]');
    return Array.from(btns).some((b) => !b.disabled);
  }, { timeout: 120000 });

  console.log('CAPTCHA solved! Clicking Verify...');

  const verifyButtons = await page.$$('button[type="submit"]');
  for (const btn of verifyButtons) {
    const isVisible = await btn.isVisible();
    const isDisabled = await btn.isDisabled();
    if (isVisible && !isDisabled) {
      await btn.click();
      break;
    }
  }

  // Wait and capture the response
  await page.waitForTimeout(8000);

  console.log('\n=== AFTER VERIFY ===');
  console.log('URL:', page.url());
  const bodyText = await page.innerText('body');
  console.log('Text:', bodyText.substring(0, 1000));

  await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/after-verify.png', fullPage: true });

  console.log('\nBrowser stays open for 60s...');
  await page.waitForTimeout(60000);
  await browser.close();
})();
