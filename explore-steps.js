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
        if (method !== 'GET' || !url.includes('on-sale-dates')) {
          console.log(`\n>>> ${method} ${url} => ${res.status()}`);
          console.log(body.substring(0, 2000));
        }
      } catch (e) {}
    }
  });

  console.log('Loading form...');
  await page.goto('https://go.seated.com/event-reminders/479a0de0-ae6c-4b71-a247-14ca323a2f94/info', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Fill text fields
  const inputs = await page.$$('input');
  await inputs[0].fill('Haiya');
  await inputs[1].fill('Krespine');
  await inputs[2].fill('haiyakrespine@gmail.com');
  await inputs[3].fill('H3X1Y9');

  // Click the circular checkbox ICONS (the circle SVG/div to the left of the text)
  // The checkbox area is a parent div containing both the circle and the label text
  // Let's find clickable elements near the checkbox text using xpath/locator
  const ageRow = page.locator('div.pointer:has-text("I confirm that I am 13 years")').first();
  const optinRow = page.locator('div.pointer:has-text("I agree to receive")').first();

  // Try clicking the parent row that wraps both the circle icon and the text
  // First, let's debug what the checkbox area looks like
  const checkboxAreas = await page.$$('div.pointer');
  console.log(`Found ${checkboxAreas.length} pointer divs`);
  for (let i = 0; i < checkboxAreas.length; i++) {
    const text = await checkboxAreas[i].innerText();
    const box = await checkboxAreas[i].boundingBox();
    console.log(`  [${i}] text="${text.substring(0, 60)}" box=${JSON.stringify(box)}`);
  }

  // Click each checkbox area - the ones with empty text are likely the circle icons
  for (const cb of checkboxAreas) {
    await cb.click();
    await page.waitForTimeout(300);
  }

  await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/step1-checked.png', fullPage: true });

  // Verify checkboxes are checked
  const bodyText = await page.innerText('body');
  const hasAgeError = bodyText.includes('You must confirm your age');
  console.log(`\nAge error visible: ${hasAgeError}`);

  console.log('Clicking Next...');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);

  // Check if we advanced
  console.log('\n=== AFTER NEXT ===');
  console.log('URL:', page.url());
  const text2 = await page.innerText('body');
  console.log('Text:', text2.substring(0, 2000));

  // If still on step 1 with error, take screenshot
  await page.screenshot({ path: '/Users/jonabitbol/Desktop/seated/step2-screenshot.png', fullPage: true });

  // Look for step 3 if we advanced
  if (!text2.includes('You must confirm')) {
    const step2Inputs = await page.$$('input');
    console.log(`\nStep 2 has ${step2Inputs.length} inputs`);

    const step2Elements = await page.$$eval('input, button[type="submit"], select', (els) =>
      els.map((el) => ({
        tag: el.tagName,
        type: el.type,
        parentText: el.parentElement?.innerText?.substring(0, 80) || '',
      }))
    );
    console.log(JSON.stringify(step2Elements, null, 2));

    // Try to advance to step 3
    const btn2 = await page.$('button[type="submit"]');
    if (btn2) {
      const btnText = await btn2.innerText();
      console.log(`\nStep 2 button: "${btnText}"`);
    }
  }

  console.log('\n=== ALL SEATED API CALLS ===');
  apiCalls.forEach((r) => {
    console.log(`${r.method} ${r.url} => ${r.status}`);
    if (r.method === 'POST') console.log(`  BODY: ${r.body.substring(0, 1000)}`);
  });

  await browser.close();
})();
