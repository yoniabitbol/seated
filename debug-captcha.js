const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Quick step 1
  const inputs = await page.$$('input');
  await inputs[0].fill('Haiya');
  await inputs[1].fill('Krespine');
  await inputs[2].fill('haiyakrespine@gmail.com');
  await inputs[3].fill('H3X1Y9');
  const cbs = await page.$$('div.pointer');
  for (const cb of cbs) { await cb.click(); await page.waitForTimeout(200); }
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  console.log('On phone page:', page.url());

  // Debug: all buttons and their states
  const buttons = await page.$$eval('button', (els) =>
    els.map((el) => ({
      type: el.type,
      text: el.innerText.substring(0, 50),
      disabled: el.disabled,
      className: el.className.substring(0, 100),
      parentTag: el.parentElement?.tagName,
      boundingBox: el.getBoundingClientRect(),
    }))
  );
  console.log('\n=== ALL BUTTONS ===');
  console.log(JSON.stringify(buttons, null, 2));

  // Debug: turnstile widget details
  const turnstileInfo = await page.evaluate(() => {
    const info = {};
    // Check window.turnstile
    if (window.turnstile) {
      info.hasTurnstile = true;
      info.turnstileMethods = Object.keys(window.turnstile);
    }
    // Check for callback functions
    if (window.turnstileCallback) {
      info.hasCallback = true;
    }
    // Check cf-turnstile div
    const cfDiv = document.querySelector('.cf-turnstile');
    if (cfDiv) {
      info.cfDivAttrs = Array.from(cfDiv.attributes).map(a => `${a.name}=${a.value.substring(0, 80)}`);
      info.cfDivDataCallback = cfDiv.getAttribute('data-callback');
      info.cfDivDataResponseFieldName = cfDiv.getAttribute('data-response-field-name');
    }
    // Check hidden input
    const hidden = document.querySelector('input[name="cf-turnstile-response"]');
    if (hidden) {
      info.hiddenInputId = hidden.id;
      info.hiddenInputValue = hidden.value.substring(0, 40) || '(empty)';
    }
    // Check for any Ember/app-level state
    const appEl = document.querySelector('[id*="ember"]');
    if (appEl) info.hasEmber = true;

    // Look for any window-level functions related to captcha
    const captchaFuncs = Object.keys(window).filter(k =>
      k.toLowerCase().includes('captcha') ||
      k.toLowerCase().includes('turnstile') ||
      k.toLowerCase().includes('verify') ||
      k.toLowerCase().includes('token')
    );
    info.captchaRelatedGlobals = captchaFuncs;

    return info;
  });
  console.log('\n=== TURNSTILE INFO ===');
  console.log(JSON.stringify(turnstileInfo, null, 2));

  // Check the iframe inside turnstile
  const iframeInfo = await page.$$eval('iframe', (els) =>
    els.map((el) => ({
      src: el.src?.substring(0, 150),
      id: el.id,
      name: el.name,
      title: el.title,
      width: el.width,
      height: el.height,
      parentClass: el.parentElement?.className?.substring(0, 80),
    }))
  );
  console.log('\n=== IFRAMES ===');
  console.log(JSON.stringify(iframeInfo, null, 2));

  // Check HTML around the verify button area
  const formArea = await page.$eval('form', (el) => el?.innerHTML?.substring(0, 2000)).catch(() => 'no form tag');
  console.log('\n=== FORM HTML ===');
  console.log(formArea);

  // If no form tag, check the main content area
  if (formArea === 'no form tag') {
    const mainContent = await page.evaluate(() => {
      // Find the area around the Verify button
      const btns = Array.from(document.querySelectorAll('button'));
      const verifyBtn = btns.find(b => b.innerText.includes('Verify'));
      if (verifyBtn) {
        // Go up several levels
        let el = verifyBtn;
        for (let i = 0; i < 5; i++) {
          if (el.parentElement) el = el.parentElement;
        }
        return el.innerHTML.substring(0, 3000);
      }
      return 'no verify button found';
    });
    console.log('\n=== VERIFY BUTTON AREA HTML ===');
    console.log(mainContent);
  }

  await browser.close();
})();
