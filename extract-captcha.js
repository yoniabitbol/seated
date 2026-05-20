const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Capture all scripts and iframes
  const scriptUrls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('turnstile') || url.includes('challenge') || url.includes('captcha') || url.includes('cf-')) {
      scriptUrls.push({ method: req.method(), url });
    }
  });

  await page.goto('https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Fill step 1
  const inputs = await page.$$('input');
  await inputs[0].fill('Haiya');
  await inputs[1].fill('Krespine');
  await inputs[2].fill('haiyakrespine@gmail.com');
  await inputs[3].fill('H3X1Y9');

  const checkboxAreas = await page.$$('div.pointer');
  for (const cb of checkboxAreas) {
    await cb.click();
    await page.waitForTimeout(200);
  }

  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);

  console.log('=== ON PHONE PAGE ===');
  console.log('URL:', page.url());

  // Find Turnstile sitekey
  // Check for cf-turnstile div with data-sitekey
  const turnstileData = await page.$$eval('[data-sitekey], .cf-turnstile, iframe[src*="turnstile"], iframe[src*="challenge"]', (els) =>
    els.map((el) => ({
      tag: el.tagName,
      sitekey: el.getAttribute('data-sitekey') || '',
      src: el.src || '',
      className: el.className || '',
      id: el.id || '',
      allAttrs: Array.from(el.attributes).map(a => `${a.name}=${a.value}`).join(', '),
    }))
  );
  console.log('\n=== TURNSTILE ELEMENTS ===');
  console.log(JSON.stringify(turnstileData, null, 2));

  // Also check for sitekey in inline scripts
  const sitekeys = await page.$$eval('script', (scripts) => {
    const results = [];
    scripts.forEach((s) => {
      const text = s.textContent || '';
      if (text.includes('sitekey') || text.includes('turnstile') || text.includes('0x4')) {
        results.push(text.substring(0, 500));
      }
    });
    return results;
  });
  console.log('\n=== INLINE SCRIPT SITEKEYS ===');
  console.log(JSON.stringify(sitekeys, null, 2));

  // Check all iframes
  const iframes = await page.$$eval('iframe', (els) =>
    els.map((el) => ({ src: el.src, id: el.id, name: el.name, title: el.title }))
  );
  console.log('\n=== IFRAMES ===');
  console.log(JSON.stringify(iframes, null, 2));

  // Check full page HTML for sitekey patterns
  const html = await page.content();
  const sitekeyMatch = html.match(/sitekey['":\s]+([0-9A-Za-z_-]+)/g);
  console.log('\n=== SITEKEY REGEX MATCHES ===');
  console.log(sitekeyMatch);

  // Also check for turnstile in the HTML
  const turnstileMatches = html.match(/turnstile[^"'\s]{0,200}/gi);
  console.log('\n=== TURNSTILE MENTIONS ===');
  console.log(turnstileMatches?.slice(0, 10));

  // Check for hidden input that might store the token
  const hiddenInputs = await page.$$eval('input[type="hidden"]', (els) =>
    els.map((el) => ({
      name: el.name,
      id: el.id,
      value: el.value?.substring(0, 100),
      className: el.className,
    }))
  );
  console.log('\n=== HIDDEN INPUTS ===');
  console.log(JSON.stringify(hiddenInputs, null, 2));

  console.log('\n=== CAPTCHA-RELATED REQUESTS ===');
  scriptUrls.forEach((r) => console.log(`${r.method} ${r.url}`));

  // Dump the full HTML of the captcha area
  const captchaArea = await page.$('.cf-turnstile, [data-sitekey], div:has(iframe[src*="challenge"])');
  if (captchaArea) {
    const captchaHtml = await captchaArea.innerHTML();
    console.log('\n=== CAPTCHA AREA HTML ===');
    console.log(captchaHtml.substring(0, 1000));
  }

  // Search for 0x4 pattern (Turnstile sitekeys start with 0x4)
  const turnstileKeyMatch = html.match(/0x4[A-Za-z0-9_-]{20,}/g);
  console.log('\n=== 0x4 KEY MATCHES ===');
  console.log(turnstileKeyMatch);

  await browser.close();
})();
