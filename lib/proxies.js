// Proxy pools with health tracking, /24 concurrency caps, per-event cooldowns
// and a persisted geo cache (so each IP is only ever looked up once).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

class ProxyError extends Error {
  constructor(msg) { super(msg); this.kind = 'proxy'; }
}

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function subnet24(ip) {
  const m = ip.match(/^(\d+\.\d+\.\d+)\./);
  return m ? m[1] : ip;
}

class ProxyPool {
  constructor() {
    this.proxies = [];       // {server, username, password, label, pool, weight, subnet}
    this.stats = {};         // label -> {ok, fail, consecFail, geo, lastUsed}
    this.subnetActive = new Map(); // /24 -> in-flight count
    this.eventUsed = new Map();    // label -> {eventId: timestamp}
    this.lookupChain = Promise.resolve(); // serializes live geo lookups
    this._loadStats();
  }

  _loadStats() {
    try { this.stats = JSON.parse(fs.readFileSync(cfg.STATS_FILE, 'utf8')); } catch { this.stats = {}; }
  }

  _saveStats() {
    try { fs.writeFileSync(cfg.STATS_FILE, JSON.stringify(this.stats, null, 1)); } catch {}
  }

  load() {
    let idx = 0;
    for (const { file, pool, weight } of cfg.PROXY_FILES) {
      const full = path.join(cfg.ROOT, file);
      for (const line of loadLines(full)) {
        const p = line.split(':');
        if (p.length !== 4) continue;
        const [ip, port, username, password] = p;
        idx++;
        const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
        this.proxies.push({
          server: `http://${ip}:${port}`,
          username,
          password,
          // Unique label per line: gateway-style lists share host:port and
          // rotate via username session strings, so per-ip:port labels would
          // collapse cooldowns/quarantine/stats into one entry.
          label: `${ip}:${port}#${idx}`,
          ip,
          pool,
          weight,
          // Real IPs group by /24; hostnames get a per-line key so the subnet
          // cap throttles per session instead of the whole provider pool.
          subnet: isIp ? subnet24(ip) : `${ip}:${port}#${idx}`,
        });
      }
    }
    if (!this.proxies.length) throw new ProxyError('no usable proxies found (isp.txt / residential.txt)');
    const byPool = {};
    for (const p of this.proxies) byPool[p.pool] = (byPool[p.pool] || 0) + 1;
    return byPool;
  }

  _stat(label) {
    if (!this.stats[label]) this.stats[label] = { ok: 0, fail: 0, consecFail: 0, geo: null };
    return this.stats[label];
  }

  // Geo lookup, persisted in the stats file so it happens once per IP ever.
  // Serialized and paced to stay inside free rate limits. ipapi.co proved
  // unreliable (low quota), so: ipwho.is primary, ip-api.com fallback.
  async geo(proxy, tag) {
    const st = this._stat(proxy.label);
    if (st.geo) return st.geo;
    // Hostname gateways (residential session strings) have no meaningful IP
    // to look up - skip and fall back to the default timezone.
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(proxy.ip)) return null;
    this.lookupChain = this.lookupChain.then(async () => {
      if (st.geo) return; // another worker filled it while we waited
      await new Promise(r => setTimeout(r, 1100)); // pace: ~1 req/s
      st.geo = await this._lookup(proxy.ip, tag);
      if (st.geo) this._saveStats();
    });
    await this.lookupChain;
    return st.geo; // may still be null -> treated as US/unknown, fail-open
  }

  async _lookup(ip, tag) {
    // ipwho.is (https, 10k/mo free)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`https://ipwho.is/${ip}`, { signal: controller.signal });
      clearTimeout(timer);
      const d = await res.json();
      if (d && d.success !== false && d.country_code) {
        // ipwho.is: timezone is an object ({id, abbr, ...}), ip-api style is a string
        const tz = d.timezone && typeof d.timezone === 'object' ? d.timezone.id : d.timezone;
        return { country: d.country_code, state: d.region_code || null, city: d.city || null, timezone: tz || null };
      }
    } catch (e) {
      console.log(`  [${tag}] ipwho.is lookup failed for ${ip}: ${e.message}`);
    }
    // ip-api.com fallback (http, 45/min free)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,region,city,timezone`, { signal: controller.signal });
      clearTimeout(timer);
      const d = await res.json();
      if (d && d.status === 'success') {
        return { country: d.countryCode, state: d.region || null, city: d.city || null, timezone: d.timezone || null };
      }
    } catch (e) {
      console.log(`  [${tag}] ip-api.com lookup failed for ${ip}: ${e.message}`);
    }
    console.log(`  [${tag}] geo lookup failed for ${ip} (treating as US/unknown)`);
    return null;
  }

  _eligible(proxy, eventId, now) {
    const st = this._stat(proxy.label);
    if (st.quarantinedUntil && st.quarantinedUntil > now) return false;
    if ((this.subnetActive.get(proxy.subnet) || 0) >= cfg.MAX_PER_SUBNET_24) return false;
    const used = this.eventUsed.get(proxy.label);
    if (used && used[eventId] && now - used[eventId] < cfg.PROXY_EVENT_COOLDOWN_MS) return false;
    return true;
  }

  // Acquire a proxy for an event. Respects pool weights, /24 caps, cooldowns,
  // quarantine. Waits (up to 2 min) for one to free up before throwing.
  async acquire(eventId, tag) {
    const deadline = Date.now() + 120000;
    for (;;) {
      const now = Date.now();
      const eligible = this.proxies.filter(p => this._eligible(p, eventId, now));
      if (eligible.length) {
        // weighted pick
        const bag = [];
        for (const p of eligible) for (let i = 0; i < p.weight; i++) bag.push(p);
        const proxy = bag[Math.floor(Math.random() * bag.length)];
        this.subnetActive.set(proxy.subnet, (this.subnetActive.get(proxy.subnet) || 0) + 1);
        if (!this.eventUsed.has(proxy.label)) this.eventUsed.set(proxy.label, {});
        this.eventUsed.get(proxy.label)[eventId] = now;
        const geo = await this.geo(proxy, tag);
        return { ...proxy, geo };
      }
      if (Date.now() > deadline) throw new ProxyError('no eligible proxy available (all capped/cooling/quarantined)');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  release(proxy) {
    const n = (this.subnetActive.get(proxy.subnet) || 1) - 1;
    if (n <= 0) this.subnetActive.delete(proxy.subnet); else this.subnetActive.set(proxy.subnet, n);
  }

  reportResult(proxy, ok) {
    const st = this._stat(proxy.label);
    if (ok) { st.ok++; st.consecFail = 0; }
    else {
      st.fail++;
      st.consecFail++;
      if (st.consecFail >= cfg.PROXY_QUARANTINE_FAILS) {
        st.quarantinedUntil = Date.now() + cfg.PROXY_QUARANTINE_MS;
        st.consecFail = 0;
        console.log(`  [proxy] quarantining ${proxy.label} for 30m (${cfg.PROXY_QUARANTINE_FAILS} consecutive failures)`);
      }
    }
    this._saveStats();
  }

  summary() {
    const quarantined = Object.values(this.stats).filter(s => s.quarantinedUntil && s.quarantinedUntil > Date.now()).length;
    const geoCached = Object.values(this.stats).filter(s => s.geo).length;
    return { total: this.proxies.length, quarantined, geoCached };
  }
}

module.exports = { ProxyPool, ProxyError };
