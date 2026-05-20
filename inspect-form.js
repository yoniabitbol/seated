const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Capture all network requests to find API endpoints
  const apiRequests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('api') || url.includes('graphql') || req.method() !== 'GET' || url.includes('.json')) {
      apiRequests.push({ method: req.method(), url, headers: req.headers(), postData: req.postData() });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('api') || url.includes('graphql') || url.includes('.json')) {
      try {
        const body = await res.text();
        console.log(`\n=== RESPONSE: ${res.status()} ${url} ===`);
        console.log(body.substring(0, 2000));
      } catch (e) {}
    }
  });

  console.log('Navigating to form...');
  await page.goto('https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('\n=== PAGE TITLE ===');
  console.log(await page.title());

  console.log('\n=== PAGE URL ===');
  console.log(page.url());

  console.log('\n=== VISIBLE TEXT (first 3000 chars) ===');
  const text = await page.innerText('body');
  console.log(text.substring(0, 3000));

  console.log('\n=== FORM ELEMENTS ===');
  const inputs = await page.$$eval('input, select, textarea, button, [role="button"], [type="submit"]', (els) =>
    els.map((el) => ({
      tag: el.tagName,
      type: el.type || '',
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      value: el.value || '',
      text: el.innerText?.substring(0, 100) || '',
      className: el.className?.substring(0, 100) || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      dataTestId: el.getAttribute('data-testid') || '',
      required: el.required || false,
    }))
  );
  console.log(JSON.stringify(inputs, null, 2));

  console.log('\n=== LINKS ===');
  const links = await page.$$eval('a', (els) =>
    els.map((el) => ({ href: el.href, text: el.innerText?.substring(0, 50) }))
  );
  console.log(JSON.stringify(links, null, 2));

  console.log('\n=== ALL API REQUESTS CAPTURED ===');
  apiRequests.forEach((r) => {
    console.log(`${r.method} ${r.url}`);
    if (r.postData) console.log(`  POST DATA: ${r.postData.substring(0, 500)}`);
  });

  // Take a screenshot for reference
  await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/step1-screenshot.png', fullPage: true });
  console.log('\nScreenshot saved to step1-screenshot.png');

  await browser.close();
})();
