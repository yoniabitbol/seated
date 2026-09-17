// Central config: env keys, events, tunables. No secrets in source - see .env.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Tiny .env loader (no dependency). Existing process.env wins.
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
})();

module.exports = {
  ROOT,
  OUT_DIR: path.join(ROOT, 'out'),
  STATS_FILE: path.join(ROOT, 'proxy-stats.json'),
  RUN_LOG: path.join(ROOT, 'out', 'run-log.jsonl'),

  // ── Services ──
  SMSPOOL_KEY: process.env.SMSPOOL_KEY || '',
  SMSPOOL_COUNTRY: '1',
  SMSPOOL_SERVICE: '810', // seated
  SMSPOOL_MAX_PRICE: '0.14',

  FIVESIM_KEY: process.env.FIVESIM_KEY || '',
  FIVESIM_COUNTRY: 'usa',
  FIVESIM_OPERATOR: 'any',
  FIVESIM_PRODUCT: 'seated',

  CAPSOLVER_KEY: process.env.CAPSOLVER_KEY || '',
  TURNSTILE_SITEKEY: '0x4AAAAAABfzvZ90HatPQ_OU', // from seated page config (fallback)

  // ── Events: emails.txt is split sequentially across these in order. ──
  // First `count` emails -> first event, next `count` -> second event, etc.
  // Each event tracks its own progress in completed-<eventId>.txt, so reruns resume.
  EVENTS: [
    { name: '1', url: 'https://go.seated.com/event-reminders/b685fd6a-35a3-4d47-a2b1-8a383c739d7b/info', count: 250 },
    { name: '2', url: 'https://go.seated.com/event-reminders/45399e31-76b5-4645-bfed-2bbd54fa66dd/info', count: 250 }

  ],


  // ── Proxy pools: first file that exists provides that pool. ──
  // Weight = relative chance a task draws from that pool (residential preferred).
  PROXY_FILES: [
    { file: 'residential.txt', pool: 'residential', weight: 3 },
    { file: 'isp.txt', pool: 'isp', weight: 1 },
  ],
  MAX_PER_SUBNET_24: 2,               // max concurrent tasks per proxy /24
  PROXY_EVENT_COOLDOWN_MS: 10 * 60000, // same proxy can't hit the same event twice within this window
  PROXY_QUARANTINE_FAILS: 3,          // consecutive failures before quarantine
  PROXY_QUARANTINE_MS: 30 * 60000,

  // ── Flow tuning ──
  MAX_ATTEMPTS: 3,
  ATTEMPT_TIMEOUT_MS: 5 * 60000,
  TASK_TIMEOUT_MS: 10 * 60000,
  SMS_WAIT_MS: 180000,
  SMS_POLL_MS: 2000,
  CAPSOLVER_TIMEOUT_MS: 150000,
  TURNSTILE_CLICK_FALLBACK_MS: 90000,

  DEFAULT_WORKERS: 25,
  DEFAULT_RPM: 15, // max task starts per minute (velocity throttle)
};
