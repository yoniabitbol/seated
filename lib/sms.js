// SMS number providers (SMSPool + 5sim) with a uniform interface.
// FatalError = unrecoverable for the whole run (e.g. balance empty) -> stop everything.
const cfg = require('./config');

class FatalError extends Error {
  constructor(msg) { super(msg); this.fatal = true; }
}

async function fetchJson(url, timeoutMs = 15000, headers = {}) {
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
  return { Authorization: `Bearer ${cfg.FIVESIM_KEY}`, Accept: 'application/json' };
}

// Order a number. Returns { phone, orderId, provider }.
async function orderNumber(provider, tag, retries = 3) {
  const isFivesim = provider === '5sim';
  const url = isFivesim
    ? `https://5sim.net/v1/user/buy/activation/${cfg.FIVESIM_COUNTRY}/${cfg.FIVESIM_OPERATOR}/${cfg.FIVESIM_PRODUCT}`
    : `https://api.smspool.net/purchase/sms?key=${cfg.SMSPOOL_KEY}&country=${cfg.SMSPOOL_COUNTRY}&service=${cfg.SMSPOOL_SERVICE}&max_price=${cfg.SMSPOOL_MAX_PRICE}`;

  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const data = await fetchJson(url, 15000, isFivesim ? fivesimHeaders() : {});
      if (isFivesim) {
        if (data && data.id && data.phone) {
          console.log(`  [${tag}] Number: ${data.phone} (${data.id}) via 5sim`);
          return { phone: String(data.phone), orderId: data.id, provider };
        }
        last = JSON.stringify(data);
        console.error(`  [${tag}] 5sim order attempt ${attempt}: ${last}`);
        if (/not enough|balance|money/i.test(last)) throw new FatalError(`5sim balance issue: ${last}`);
      } else {
        if (data.success === 1) {
          console.log(`  [${tag}] Number: ${data.phonenumber} (${data.order_id}) via smspool`);
          return { phone: String(data.phonenumber), orderId: data.order_id, provider };
        }
        last = JSON.stringify(data);
        console.error(`  [${tag}] SMSPool order attempt ${attempt}: ${last}`);
        if (/insufficient|balance|fund/i.test(last)) throw new FatalError(`SMSPool balance issue: ${last}`);
        if (/no numbers|out of stock|available/i.test(last)) {
          await new Promise(r => setTimeout(r, 20000)); // temporary stock issue
          continue;
        }
      }
    } catch (err) {
      if (err.fatal) throw err;
      last = err.message;
      console.error(`  [${tag}] ${provider} order attempt ${attempt} network error: ${err.message}`);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`${provider} order failed after ${retries} attempts: ${last}`);
}

async function cancelOrder(order, tag) {
  if (!order) return;
  try {
    if (order.provider === '5sim') {
      await fetchJson(`https://5sim.net/v1/user/cancel/${order.orderId}`, 15000, fivesimHeaders());
    } else {
      await fetchJson(`https://api.smspool.net/sms/cancel?key=${cfg.SMSPOOL_KEY}&orderid=${order.orderId}`);
    }
    console.log(`  [${tag}] cancelled order ${order.orderId}`);
  } catch (err) {
    console.error(`  [${tag}] cancel order ${order.orderId} failed: ${err.message}`);
  }
}

function extractCode(text) {
  const m = String(text || '').match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

// Poll for the OTP. Returns the code string, or null on timeout.
async function pollForCode(order, tag, { timeoutMs = cfg.SMS_WAIT_MS, intervalMs = cfg.SMS_POLL_MS, previousCodes = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      if (order.provider === '5sim') {
        const data = await fetchJson(`https://5sim.net/v1/user/check/${order.orderId}`, 15000, fivesimHeaders());
        if (data && Array.isArray(data.sms) && data.sms.length) {
          const last = data.sms[data.sms.length - 1];
          const code = last.code || extractCode(last.text);
          if (code && !previousCodes.includes(code)) {
            console.log(`  [${tag}] SMS code: ${code}`);
            return code;
          }
        }
      } else {
        const data = await fetchJson(`https://api.smspool.net/sms/check?key=${cfg.SMSPOOL_KEY}&orderid=${order.orderId}`);
        if (data.status === 2) throw new Error(`order refunded/cancelled: ${JSON.stringify(data)}`);
        if (data.status === 3 || data.sms) {
          const code = extractCode(data.sms) || extractCode(data.full_sms) || (data.sms && String(data.sms).trim());
          if (code && !previousCodes.includes(code)) {
            console.log(`  [${tag}] SMS code: ${code}`);
            return code;
          }
        }
      }
    } catch (err) {
      if (err.message.includes('refunded')) throw err;
      // transient poll errors are ignored, keep polling
    }
  }
  return null;
}

// US 10-digit form for the seated form (it defaults to +1).
function toUsDigits(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

module.exports = { orderNumber, cancelOrder, pollForCode, toUsDigits, FatalError };
