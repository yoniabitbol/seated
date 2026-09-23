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
  // Pool that honors custom area codes for the seated service (7 = Foxtrot).
  // Only used when an event sets `areaCodes`; plain orders keep SMSPool's
  // automatic pool selection.
  SMSPOOL_AREA_POOL: '7',

  FIVESIM_KEY: process.env.FIVESIM_KEY || '',
  FIVESIM_COUNTRY: 'usa',
  FIVESIM_OPERATOR: 'any',
  FIVESIM_PRODUCT: 'seated',

  CAPSOLVER_KEY: process.env.CAPSOLVER_KEY || '',
  TURNSTILE_SITEKEY: '0x4AAAAAABfzvZ90HatPQ_OU', // from seated page config (fallback)

  // ── Events: emails.txt is split sequentially across these in order. ──
  // First `count` emails -> first event, next `count` -> second event, etc.
  // Each event tracks its own progress in completed-<eventId>.txt, so reruns resume.
  // Optional `areaCodes: [212, 646]` (number, string or array): each task picks
  // one at random, orders an SMSPool number in that area code, and uses a
  // postal code from that area code's state (instead of the proxy's state).
  // Forces the smspool provider for that event (5sim has no area-code option).
  EVENTS: [
    // { name: '1', url: 'https://go.seated.com/waitlist/1dc67705-c78a-4484-a553-43d5064694fa/info', count: 50, areaCodes: [860,959]},
    // { name: '2', url: 'https://go.seated.com/waitlist/8dffa0d7-ddba-45ee-a1af-fa05a194ad58/info', count: 50, areaCodes: [860,959]},
    // { name: '3', url: 'https://go.seated.com/waitlist/b09c1cee-2c69-44cf-ae6c-e3b61720d3e4/info', count: 50, areaCodes: [412,724,878]},
    // { name: '4', url: 'https://go.seated.com/waitlist/ed67a238-0c69-4cc5-8c82-daa199f7734c/info', count: 50, areaCodes: [412,724,878]},
    { name: '5', url: 'https://go.seated.com/waitlist/7873ca02-64b0-48ad-a1ed-13755687bbf0/info', count: 100, areaCodes: [202,771]},
    { name: '6', url: 'https://go.seated.com/waitlist/12d1ad0c-45ee-4aec-9294-8862205aa082/info', count: 100, areaCodes: [202,771]},
    // { name: '7', url: 'https://go.seated.com/waitlist/021d22f9-0316-4ad2-8b00-f7a900792007/info', count: 50, areaCodes: [704,980]},
    // { name: '8', url: 'https://go.seated.com/waitlist/dbb50c33-4584-47b7-a2c7-846f2872bb6b/info', count: 50, areaCodes: [704,980]},
    // // Chicago, IL - United Center
    // { name: '9', url: 'https://go.seated.com/waitlist/d0dd562b-5257-4e32-8c4b-e8211dec8a17/info', count: 50, areaCodes: [312,773,872] }, // Oct 11, 2026
    // { name: '10', url: 'https://go.seated.com/waitlist/8af1fe1f-b7c2-4305-b269-20435ac418de/info', count: 50, areaCodes: [312,773,872] }, // Oct 12, 2026
    // // Boston, MA - TD Garden
    // { name: '11', url: 'https://go.seated.com/waitlist/47c42a22-95cb-4cac-93f7-081e7ca88e4e/info', count: 50, areaCodes: [617,857] }, // Oct 15, 2026
    // { name: '12', url: 'https://go.seated.com/waitlist/fd2648ef-4864-4d12-8c91-10dbee9d8898/info', count: 50, areaCodes: [617,857] }, // Oct 17, 2026
    // { name: '13', url: 'https://go.seated.com/waitlist/b69b57f4-27a1-4ce9-b297-ef3e196c4605/info', count: 50, areaCodes: [617,857] }, // Oct 18, 2026
    // // Columbus, OH - Schottenstein Center
    // { name: '14', url: 'https://go.seated.com/waitlist/11d0488b-c931-4791-bb18-3efbfc50df05/info', count: 50, areaCodes: [614,380] }, // Oct 29, 2026
    // { name: '15', url: 'https://go.seated.com/waitlist/063c16c4-0e3b-4c7e-accd-0cccd8ee1e8b/info', count: 50, areaCodes: [614,380] }, // Oct 30, 2026
    // // Philadelphia, PA - Xfinity Mobile Arena
    // { name: '16', url: 'https://go.seated.com/waitlist/dd0a8198-071d-47b1-9d18-bbb2d28eaa4c/info', count: 50, areaCodes: [215,267,445] }, // Nov 7, 2026
    // { name: '17', url: 'https://go.seated.com/waitlist/b825c48e-7133-4294-9eaf-405b723f467a/info', count: 50, areaCodes: [215,267,445] }, // Nov 8, 2026
    // // Atlanta, GA - State Farm Arena
    // { name: '18', url: 'https://go.seated.com/waitlist/b13d0e33-266f-42f0-a86f-ca68eb5071ea/info', count: 50, areaCodes: [404,470,678,770] }, // Nov 11, 2026
    // { name: '19', url: 'https://go.seated.com/waitlist/b324179e-7136-43f6-87ba-8c69a36d5686/info', count: 50, areaCodes: [404,470,678,770] }, // Nov 12, 2026
    // // Orlando, FL - Kia Center
    // { name: '20', url: 'https://go.seated.com/waitlist/d20fb4e4-9a13-4220-ad4b-875c9757fd16/info', count: 50, areaCodes: [407,689] }, // Nov 15, 2026
    // { name: '21', url: 'https://go.seated.com/waitlist/02d056e4-ac10-4790-9ce5-142b2102d685/info', count: 50, areaCodes: [407,689] }, // Nov 16, 2026
    // // Sunrise, FL - Amerant Bank Arena
    // { name: '22', url: 'https://go.seated.com/waitlist/eca97e69-0e44-4eea-80ce-92ac16a0c8c7/info', count: 50, areaCodes: [954,754] }, // Nov 19, 2026
    // { name: '23', url: 'https://go.seated.com/waitlist/17276db1-8f4d-455d-9d5d-27f20247a720/info', count: 50, areaCodes: [954,754] }, // Nov 20, 2026
    // // Nashville, TN - Bridgestone Arena
    // { name: '24', url: 'https://go.seated.com/waitlist/0fb141b5-82d7-450b-827d-454b08298d69/info', count: 50, areaCodes: [615,629] }, // Nov 23, 2026
    // { name: '25', url: 'https://go.seated.com/waitlist/bd9a5b24-8336-4314-a04d-e78258017e6b/info', count: 50, areaCodes: [615,629] }, // Nov 24, 2026
    // // Seattle, WA - Climate Pledge Arena
    // { name: '26', url: 'https://go.seated.com/waitlist/57821a84-7838-471e-b350-4e3f31831946/info', count: 50, areaCodes: [206] }, // Dec 7, 2026
    // { name: '27', url: 'https://go.seated.com/waitlist/2397d780-b84b-431a-8e98-b348728d526c/info', count: 50, areaCodes: [206] }, // Dec 8, 2026
    // // Oakland, CA - Oakland Arena
    // { name: '28', url: 'https://go.seated.com/waitlist/755783b6-e6ec-4bea-a755-ff3f9b35f9dc/info', count: 50, areaCodes: [510,341] }, // Dec 11, 2026
    // { name: '29', url: 'https://go.seated.com/waitlist/7a60ddb0-4560-4a95-9459-071765cd8d1c/info', count: 50, areaCodes: [510,341] }, // Dec 12, 2026
    // // Sacramento, CA - Golden 1 Center
    // { name: '30', url: 'https://go.seated.com/waitlist/6f51fca5-d232-4ebd-9df9-72afce1ed202/info', count: 50, areaCodes: [916,279] }, // Dec 15, 2026
    // { name: '31', url: 'https://go.seated.com/waitlist/945154a6-5edc-46ea-92be-13445d24d4f3/info', count: 50, areaCodes: [916,279] }, // Dec 16, 2026
    // // Las Vegas, NV - T-Mobile Arena
    // { name: '32', url: 'https://go.seated.com/waitlist/ffc24b55-00c3-4329-bd74-03813ad41172/info', count: 50, areaCodes: [702,725] }, // Dec 19, 2026
    // { name: '33', url: 'https://go.seated.com/waitlist/2e976310-a665-458d-91cf-dd74d6d9589d/info', count: 50, areaCodes: [702,725] }, // Dec 20, 2026
    // // Los Angeles, CA - Intuit Dome
    // { name: '34', url: 'https://go.seated.com/waitlist/a54729c1-11ec-4bdd-8043-8e5cd37aa861/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 12, 2027
    // { name: '35', url: 'https://go.seated.com/waitlist/37da6881-9dff-42fc-a5ed-28017839ce42/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 13, 2027
    // { name: '36', url: 'https://go.seated.com/waitlist/7a324812-96a8-4678-a549-4455d25c9157/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 16, 2027
    // { name: '37', url: 'https://go.seated.com/waitlist/8feb22dd-abd6-4cd3-82e5-686ec9c67ae2/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 17, 2027
    // { name: '38', url: 'https://go.seated.com/waitlist/6c2f42c3-0f5c-404a-a63c-2ee761216843/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 20, 2027
    // { name: '39', url: 'https://go.seated.com/waitlist/722a1dd7-425d-444d-a341-27e8dcfe90b9/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 21, 2027
    // { name: '40', url: 'https://go.seated.com/waitlist/e819ed62-0d06-4d08-ace2-d3101450b072/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 24, 2027
    // { name: '41', url: 'https://go.seated.com/waitlist/a5f0d191-1fba-45ac-909b-d4250d83eda0/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 25, 2027
    // { name: '42', url: 'https://go.seated.com/waitlist/bd1e5dd9-426d-41a0-a311-22066ae6f3d6/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 28, 2027
    // { name: '43', url: 'https://go.seated.com/waitlist/757983f9-7e7c-4914-86a8-be91d3e5f7d2/info', count: 50, areaCodes: [310,424,213,323] }, // Jan 29, 2027
    // // Brooklyn, NY - Barclays Center
    // { name: '44', url: 'https://go.seated.com/waitlist/4de54f88-a931-4413-959e-d650778eae49/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 11, 2027
    // { name: '45', url: 'https://go.seated.com/waitlist/31a54382-2f44-4131-8e76-4e5dd6349bb1/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 12, 2027
    // { name: '46', url: 'https://go.seated.com/waitlist/27e4ee87-950b-4e9a-9219-d5459cf8ab94/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 15, 2027
    // { name: '47', url: 'https://go.seated.com/waitlist/19105e5d-6145-4191-9f9d-a753dc5beea3/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 16, 2027
    // { name: '48', url: 'https://go.seated.com/waitlist/9e5ed6cc-1854-4dcf-b3b5-302462a45af2/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 19, 2027
    // { name: '49', url: 'https://go.seated.com/waitlist/442cd7e2-96d6-489f-bdb0-ac9280497b6a/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 20, 2027
    // { name: '50', url: 'https://go.seated.com/waitlist/a9a17946-9cb5-4a59-aaf6-4b68f2e38e78/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 23, 2027
    // { name: '51', url: 'https://go.seated.com/waitlist/b7fd08f1-8cf2-4b86-97a7-a5bdbe40dcf9/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 24, 2027
    // { name: '52', url: 'https://go.seated.com/waitlist/52ddc9bd-9021-498d-af8b-93931b8a4930/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 27, 2027
    // { name: '53', url: 'https://go.seated.com/waitlist/5dba7323-0136-4541-bf85-c9962106e4c1/info', count: 50, areaCodes: [718,347,929,917] }, // Feb 28, 2027
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
