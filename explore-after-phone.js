const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('api.seated.com')) {
      try {
        const body = await res.text();
        const method = res.request().method();
        apiCalls.push({ method, url, status: res.status(), body });
        console.log(`\n>>> ${method} ${url} => ${res.status()}`);
        console.log(body.substring(0, 2000));
      } catch (e) {}
    }
  });

  // Go directly to the phone page to save time — navigate through step 1 first
  await page.goto('https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1000);

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
  await page.waitForTimeout(3000);

  console.log('On phone page. Entering phone number...');

  // Fill phone number
  const phoneInput = await page.$('input[type="tel"]');
  await phoneInput.fill('5146925443');

  // We need to solve the captcha to proceed, but for now let's just see the API calls
  // that would happen. Let's also check what the form submits by looking at the page structure.

  // Check what the page structure looks like for the phone submission
  const pageHtml = await page.content();

  // Look for any fetch/XHR endpoints in the JS
  const apiPatterns = pageHtml.match(/api\.seated\.com[^"'\s]*/g);
  console.log('\n=== API PATTERNS IN HTML ===');
  console.log([...new Set(apiPatterns || [])]);

  // Look for the form action or submission patterns
  const submitPatterns = pageHtml.match(/(phone-verifications|verification|sms|otp)[^"'\s]*/gi);
  console.log('\n=== VERIFICATION PATTERNS ===');
  console.log([...new Set(submitPatterns || [])]);

  // Check the full URL structure encoded in the JS bundle
  const urlEncodedPatterns = pageHtml.match(/phone[^%"'\s]{0,100}/gi);
  console.log('\n=== PHONE URL PATTERNS ===');
  const unique = [...new Set(urlEncodedPatterns || [])].filter(p => p.length > 8);
  console.log(unique.slice(0, 20));

  // Look for "verification" or "verify" in encoded content
  const verifyPatterns = pageHtml.match(/verif[a-z-]{0,30}/gi);
  console.log('\n=== VERIFY PATTERNS ===');
  console.log([...new Set(verifyPatterns || [])].slice(0, 20));

  await browser.close();
})();
