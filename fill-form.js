#!/usr/bin/env node
// Seated waitlist/reminder signup automation - headless, parallel, low-memory.
//
// One real Chrome process (headless=new) hosts N incognito contexts, each with
// its own proxy/timezone. Turnstile is solved via CapSolver (click fallback).
// SMS numbers are only ordered AFTER step 1 + Turnstile succeed, and survive
// retries until Verify is clicked - so proxy/captcha failures cost $0.
//
// Usage:
//   node fill-form.js [options]
//     --workers N        concurrent contexts (default 15)
//     --rpm N            max task starts per minute (default 8)
//     --limit N          process at most N emails this run (0 = all)
//     --provider P       smspool | 5sim | mix (default smspool)
//     --headed           show the browser (debugging)
//     --dry-run          print the plan, do nothing
//   Ctrl-C once = finish in-flight tasks; twice = quit now.
const cfg = require('./lib/config');
const { BrowserManager } = require('./lib/browser');
const { ProxyPool, ProxyError } = require('./lib/proxies');
const sms = require('./lib/sms');
const flow = require('./lib/flow');
const store = require('./lib/store');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// ── CLI ──
function parseArgs(argv) {
  const args = { workers: cfg.DEFAULT_WORKERS, rpm: cfg.DEFAULT_RPM, limit: 0, provider: 'smspool', headed: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--workers') args.workers = parseInt(next(), 10) || args.workers;
    else if (a === '--rpm') args.rpm = parseInt(next(), 10) || args.rpm;
    else if (a === '--limit') args.limit = parseInt(next(), 10) || 0;
    else if (a === '--provider') args.provider = next();
    else if (a === '--headed') args.headed = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('node fill-form.js [--workers N] [--rpm N] [--limit N] [--provider smspool|5sim|mix] [--headed] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

// Rolling-window rate limiter: at most `rpm` task starts per minute.
class RateLimiter {
  constructor(rpm) { this.rpm = rpm; this.stamps = []; }
  async wait() {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter(t => now - t < 60000);
      if (this.stamps.length < this.rpm) {
        this.stamps.push(now);
        return;
      }
      await flow.sleep(this.stamps[0] + 60000 - now + 50);
    }
  }
}

function pickProvider(setting, task) {
  if (task && task.areaCode) return 'smspool'; // only SMSPool supports area codes
  if (setting === 'mix') return Math.random() < 0.5 ? '5sim' : 'smspool';
  return setting;
}

// Process one email: up to MAX_ATTEMPTS attempts. The SMS order (once created)
// is reused across attempts until Verify is clicked - a failed proxy or
// Turnstile never wastes a number. Only phone rejection / no-SMS burns it.
async function processTask(task, ctx) {
  const { browserMgr, proxyPool, data, args } = ctx;
  const id = store.eventId(task.event.url);
  let order = null;        // SMS order, reused across attempts
  let verifyClicked = false;
  // Area code for this task (from the event config): fixed for the whole task
  // so the postal code typed in step 1 matches the number ordered later.
  const eventAreaCodes = sms.normalizeAreaCodes(task.event.areaCodes);
  task.areaCode = eventAreaCodes.length ? eventAreaCodes[Math.floor(Math.random() * eventAreaCodes.length)] : null;

  for (let attempt = 1; attempt <= cfg.MAX_ATTEMPTS; attempt++) {
    const tag = `${task.tag} a${attempt}/${cfg.MAX_ATTEMPTS}`;
    let proxy = null;
    let context = null;
    const t0 = Date.now();
    let turnstileMethod = null;
    let verifyStatus = null;

    try {
      proxy = await proxyPool.acquire(id, tag);
      console.log(`  [${tag}] proxy ${proxy.label} (${proxy.pool}${proxy.geo ? `, ${proxy.geo.city || proxy.geo.state || proxy.geo.country}` : ''})`);

      context = await browserMgr.newContext(proxy);
      const page = await context.newPage();

      // Step 1: info. (No SMS money spent yet.)
      await flow.step1(page, task, data, proxy, tag);

      // Order the number only now, and solve Turnstile before Verify so a
      // Turnstile failure keeps the number usable for the next attempt.
      if (!order) {
        order = await sms.orderNumber(pickProvider(args.provider, task), tag, 3, {
          areaCode: task.areaCode, fallbackAreaCodes: eventAreaCodes,
        });
      }
      const digits = sms.toUsDigits(order.phone);

      const step2Result = await flow.step2(page, digits, tag);
      turnstileMethod = step2Result.method;
      verifyStatus = step2Result.verifyStatus;
      verifyClicked = true;

      const code = await sms.pollForCode(order, tag);
      if (!code) throw new flow.FlowError('phone', 'no SMS received in time');

      await flow.step3(page, code, tag);
      const auditResult = await flow.audit(page, task, tag);

      store.markCompleted(task.completedFile, task.email);
      proxyPool.reportResult(proxy, true);
      store.logRun({
        event: id, email: task.email, attempt, result: 'success',
        verified: auditResult.verified, proxy: proxy.label, pool: proxy.pool,
        geo: proxy.geo || undefined, provider: order.provider, areaCode: order.areaCode || undefined,
        turnstile: turnstileMethod, verifyStatus, ms: Date.now() - t0,
      });
      console.log(`${GREEN}  [${tag}] SUCCESS - ${task.email} (${Math.round((Date.now() - t0) / 1000)}s, turnstile: ${turnstileMethod})${RESET}`);
      return true;
    } catch (err) {
      const kind = err.kind || (String(err.message).includes('net::ERR') ? 'proxy' : 'flow');
      console.error(`${RED}  [${tag}] attempt failed (${kind}) - ${task.email}: ${String(err.message).slice(0, 150)}${RESET}`);
      if (err.fatal) { task.fatal = err.message; throw err; }
      if (kind === 'closed') { task.closed = true; return false; } // window shut - no point retrying

      if (context) await flow.errorShot(await context.pages()[0] || null, task, `error-a${attempt}`).catch(() => {});
      // Only blame the proxy for failures it plausibly caused (dead connection,
      // Turnstile refusing the IP, backend rejecting the verify - Prelude and
      // Seated both score the IP). Phone rejection / no-SMS is not its fault.
      if (proxy && (kind === 'proxy' || kind === 'turnstile' || kind === 'verify')) proxyPool.reportResult(proxy, false);
      store.logRun({
        event: id, email: task.email, attempt, result: 'fail', kind,
        error: String(err.message).slice(0, 200), proxy: proxy && proxy.label,
        pool: proxy && proxy.pool, provider: order && order.provider,
        turnstile: turnstileMethod, verifyStatus, ms: Date.now() - t0,
      });

      // Burn the number once Verify has been clicked in ANY attempt: the SMS
      // may already be in flight to this session, so reusing it is unsafe.
      if (order && verifyClicked) {
        await sms.cancelOrder(order, tag);
        order = null;
        verifyClicked = false;
      }

      if (attempt < cfg.MAX_ATTEMPTS) {
        const wait = flow.rand(4000, 9000);
        console.log(`  [${tag}] retrying in ${Math.round(wait / 1000)}s (fresh context + proxy${order ? ', same number' : ''})...`);
        await flow.sleep(wait);
      }
    } finally {
      if (proxy) proxyPool.release(proxy);
      await browserMgr.closeContext(context, tag);
    }
  }

  if (order) await sms.cancelOrder(order, task.tag);
  console.error(`${RED}  [${task.tag}] GAVE UP after ${cfg.MAX_ATTEMPTS} attempts - ${task.email}${RESET}`);
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const { tasks, uniqueCount, totalAssigned, totalDone, leftover } = store.buildTasks();
  const data = store.loadIdentityData();

  const proxyPool = new ProxyPool();
  const pools = proxyPool.load();
  const pSummary = proxyPool.summary();

  console.log(`Emails: ${uniqueCount} unique | assigned ${totalAssigned} | done ${totalDone} | pending ${tasks.length}`);
  if (leftover > 0) console.log(`${YELLOW}  Note: ${leftover} extra email(s) beyond the planned total are unassigned.${RESET}`);
  console.log(`Proxies: ${Object.entries(pools).map(([k, v]) => `${v} ${k}`).join(' + ')} | ${pSummary.quarantined} quarantined | ${pSummary.geoCached} geo-cached`);
  console.log(`Plan: ${args.workers} workers | ${args.rpm} starts/min | provider ${args.provider} | ${args.headed ? 'HEADED' : 'headless'} | ${cfg.MAX_ATTEMPTS} attempts/email`);

  if (!data.firstNames.length || !data.lastNames.length || !data.postalCodes.length) {
    console.error(`${RED}firstNames.txt / lastNames.txt / postalCodes.txt missing or empty${RESET}`);
    process.exit(1);
  }
  for (const event of cfg.EVENTS) {
    const codes = sms.normalizeAreaCodes(event.areaCodes);
    if (codes.length) console.log(`Event ${event.name}: area codes ${codes.join(', ')} (SMSPool pool ${cfg.SMSPOOL_AREA_POOL})`);
  }
  if (!tasks.length) { console.log('Nothing pending - done.'); process.exit(0); }
  if (args.dryRun) {
    for (const t of tasks.slice(0, 30)) console.log(`  ${t.email} -> event ${t.eventShort}`);
    if (tasks.length > 30) console.log(`  ... and ${tasks.length - 30} more`);
    process.exit(0);
  }

  // Pre-flight: warn about pinned area codes SMSPool has no stock for right now
  // (read-only lookup; a failed lookup is not fatal).
  const wantedCodes = [...new Set(cfg.EVENTS.flatMap(e => sms.normalizeAreaCodes(e.areaCodes)))];
  if (wantedCodes.length) {
    const inStock = await sms.availableAreaCodes();
    if (!inStock) console.log(`${YELLOW}  [PROBE] could not fetch SMSPool area-code stock, continuing${RESET}`);
    else {
      const missing = wantedCodes.filter(c => !inStock.includes(c));
      if (missing.length) console.log(`${YELLOW}  [PROBE] area codes with no SMSPool stock right now: ${missing.join(', ')} (orders will retry/widen)${RESET}`);
      else console.log(`${GREEN}  [PROBE] all ${wantedCodes.length} pinned area code(s) in SMSPool stock${RESET}`);
    }
  }

  const browserMgr = new BrowserManager({ headed: args.headed });

  // Pre-flight: probe each event once so we never burn SMS orders on a closed
  // signup window. Events whose probe fails inconclusively are kept (don't
  // block the run on a flaky probe).
  const openEvents = new Set();
  for (const event of cfg.EVENTS) {
    const probe = await flow.probeEvent(browserMgr, proxyPool, event, 'PROBE');
    if (probe.open === true) {
      console.log(`${GREEN}  [PROBE] event ${event.name}: open - ${probe.detail}${RESET}`);
      openEvents.add(event.url);
    } else if (probe.open === false) {
      console.log(`${YELLOW}  [PROBE] event ${event.name}: NO OPEN FORM - ${probe.detail} (its tasks will be skipped)${RESET}`);
    } else {
      console.log(`${YELLOW}  [PROBE] event ${event.name}: inconclusive - ${probe.detail} (keeping its tasks)${RESET}`);
      openEvents.add(event.url);
    }
  }
  const queueAll = tasks.filter(t => openEvents.has(t.event.url));
  if (!queueAll.length) {
    console.log(`${RED}No tasks for open events - nothing to do.${RESET}`);
    await browserMgr.shutdown();
    process.exit(0);
  }
  if (queueAll.length < tasks.length) {
    console.log(`${YELLOW}${tasks.length - queueAll.length} task(s) skipped (closed events).${RESET}`);
  }

  const queue = queueAll.slice(0, args.limit > 0 ? args.limit : queueAll.length);
  if (args.limit > 0 && queueAll.length > args.limit) {
    console.log(`${YELLOW}--limit ${args.limit}: processing ${queue.length} of ${queueAll.length} pending${RESET}`);
  }
  queue.forEach((t, i) => { t.tag = `${i + 1}/${queue.length} ev${t.eventShort}`; });
  const limiter = new RateLimiter(args.rpm);
  let nextIdx = 0;
  let succeeded = 0;
  let failed = 0;
  let stopping = false;
  let fatalError = null;
  const inFlight = new Set();

  const worker = async (w) => {
    await flow.sleep(w * 3000); // stagger worker starts
    while (!stopping && nextIdx < queue.length) {
      const task = queue[nextIdx++];
      await limiter.wait();
      if (stopping) { nextIdx--; break; } // put it back
      console.log(`  >> [${task.tag}] start ${task.email} (${queue.length - nextIdx} queued)`);
      const p = processTask(task, { browserMgr, proxyPool, data, args })
        .then(ok => { ok ? succeeded++ : failed++; })
        .catch(err => {
          if (err && err.fatal) { fatalError = err; stopping = true; }
          else failed++;
        })
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      await p;
    }
  };

  // Ctrl-C: first = stop pulling new tasks, second = force quit.
  let presses = 0;
  process.on('SIGINT', () => {
    presses++;
    if (presses === 1) {
      stopping = true;
      console.log(`\n${YELLOW}[Ctrl-C] finishing ${inFlight.size} in-flight task(s), then stopping (Ctrl-C again to quit NOW)${RESET}`);
      setTimeout(() => { console.log('force exit'); process.exit(1); }, 20000).unref();
    } else {
      process.exit(1);
    }
  });

  await Promise.all(Array.from({ length: args.workers }, (_, i) => worker(i)));
  await browserMgr.shutdown();

  console.log(`\n=== DONE === ${GREEN}${succeeded} ok${RESET} | ${RED}${failed} fail${RESET} | ${queue.length - nextIdx} not started`);
  if (fatalError) console.log(`${RED}Stopped early (fatal): ${fatalError.message} - unstarted emails remain pending for next run.${RESET}`);
  console.log(`  Per-event progress: completed-<eventId>.txt | audits: out/ | run log: out/run-log.jsonl`);
  process.exit(fatalError ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Fatal: ${err.stack || err.message}${RESET}`);
  process.exit(1);
});
