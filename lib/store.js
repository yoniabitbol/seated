// Task list building, per-event completed files (unchanged format -> reruns
// resume), and the structured run log (one JSON line per attempt, for later
// analysis of what correlates with wins).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

function loadLines(file) {
  const full = path.join(cfg.ROOT, file);
  if (!fs.existsSync(full)) return [];
  return fs.readFileSync(full, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function eventId(url) {
  return (url.match(/\/([a-f0-9-]{36})\//) || [])[1] || 'default';
}

function completedFileFor(url) {
  return path.join(cfg.ROOT, `completed-${eventId(url)}.txt`);
}

function loadCompleted(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function markCompleted(file, email) {
  fs.appendFileSync(file, email + '\n');
}

// Slice emails.txt sequentially across EVENTS (deterministic, same as before).
function buildTasks() {
  const allEmails = loadLines('emails.txt').filter(l => l.includes('@'));
  const uniqueEmails = [...new Set(allEmails)];

  let cursor = 0;
  const assignments = cfg.EVENTS.map(event => {
    const slice = uniqueEmails.slice(cursor, cursor + event.count);
    cursor += event.count;
    return { event, emails: slice };
  });
  const leftover = uniqueEmails.length - cursor;

  const tasks = [];
  let totalDone = 0;
  let totalAssigned = 0;
  for (const { event, emails } of assignments) {
    const completedFile = completedFileFor(event.url);
    const completed = loadCompleted(completedFile);
    totalAssigned += emails.length;
    for (const email of emails) {
      if (completed.has(email)) { totalDone++; continue; }
      tasks.push({ email, event, completedFile, eventShort: event.name });
    }
  }
  return { tasks, uniqueCount: uniqueEmails.length, totalAssigned, totalDone, leftover };
}

function loadIdentityData() {
  return {
    firstNames: loadLines('firstNames.txt'),
    lastNames: loadLines('lastNames.txt'),
    postalCodes: loadLines('postalCodes.txt'),
  };
}

// Append one JSON line per attempt to out/run-log.jsonl.
function logRun(record) {
  try {
    fs.mkdirSync(cfg.OUT_DIR, { recursive: true });
    fs.appendFileSync(cfg.RUN_LOG, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch {}
}

module.exports = { buildTasks, loadIdentityData, markCompleted, logRun, eventId };
