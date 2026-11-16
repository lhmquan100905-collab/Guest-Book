// Guest Book backend — Express API + SQLite database
// Run with: npm install   then   npm start
//
// Security model (see README):
//  - Every guest/staff endpoint requires a signed-in session (Bearer token).
//  - Only two things are open: the list of staff names (for the login
//    dropdown) and the login itself. Creating the very first staff account
//    is allowed only while no staff exist yet.
//  - Repeated wrong PINs lock the account (and the sender's address) out
//    for 15 minutes.
//  - All input is validated here on the server, not just in the browser.
//  - Two roles: 'manager' (everything) and 'staff' (floor staff: look up and
//    edit guests, log visits and occasions; cannot delete guests or manage
//    staff accounts). Roles are enforced here, not just hidden in the app.

const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node — no compilation needed
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');

// Security headers. Note: CORS is intentionally NOT enabled — the app is served
// from this same server, so other websites have no reason to call the API.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Database setup ----
const db = new DatabaseSync(path.join(__dirname, 'guestbook.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pin  TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff'
  );

  CREATE TABLE IF NOT EXISTS custom_tags (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS guest_tags (
    guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (guest_id, tag)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    role   TEXT,
    action TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guests (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS visits (
    id        TEXT PRIMARY KEY,
    guest_id  TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    note      TEXT,
    logged_by TEXT
  );

  CREATE TABLE IF NOT EXISTS occasions (
    id       TEXT PRIMARY KEY,
    guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    type     TEXT NOT NULL,
    date     TEXT NOT NULL
  );
`);

// Migration: add created_at to guests if it doesn't exist yet (for existing databases)
const guestCols = db.prepare('PRAGMA table_info(guests)').all().map(c => c.name);
if (!guestCols.includes('created_at')) {
  db.exec('ALTER TABLE guests ADD COLUMN created_at TEXT');
  db.prepare('UPDATE guests SET created_at = ? WHERE created_at IS NULL').run(new Date().toISOString());
}

// Migration: add the role column to older databases. Everyone who already has
// an account becomes floor staff, except the first account created, who
// becomes the manager (managers can promote others afterwards).
const staffCols = db.prepare('PRAGMA table_info(staff)').all().map(c => c.name);
if (!staffCols.includes('role')) {
  db.exec("ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'");
}
// Safety net: if accounts exist but nobody is a manager, nobody could manage
// staff, so the earliest account is made the manager.
if (db.prepare('SELECT COUNT(*) AS c FROM staff').get().c > 0 &&
    db.prepare("SELECT COUNT(*) AS c FROM staff WHERE role = 'manager'").get().c === 0) {
  const first = db.prepare('SELECT id, name FROM staff ORDER BY rowid LIMIT 1').get();
  db.prepare("UPDATE staff SET role = 'manager' WHERE id = ?").run(first.id);
  console.log(`[setup] No manager found: ${first.name} (the earliest account) is now the manager.`);
}

const uid = (prefix) => prefix + '-' + crypto.randomBytes(5).toString('hex');

// ---- PIN hashing (scrypt, built into Node — no extra dependency) ----
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(pin, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// ---- Input validation (server-side) ----
const ID_RE = /^[gsvo]-[0-9a-f]{10}$/;
const PIN_RE = /^\d{4,6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OCCASION_TYPES = ['Birthday', 'Anniversary', 'Other'];
const ROLES = ['manager', 'staff'];

const stripControl = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const text = (v) => (typeof v === 'string' ? stripControl(v).trim() : '');
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < 1900 || year > 2100) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// ---- Tags: tap-to-select, fixed list, so nothing can be mistyped ----
// To add or rename a tag, edit this list only (the app reads it from /api/tags).
const TAG_GROUPS = [
  { group: 'Allergies', kind: 'allergy', tags: [
    ['allergy-peanut', 'Peanut'], ['allergy-tree-nut', 'Tree nut'], ['allergy-shellfish', 'Shellfish'],
    ['allergy-fish', 'Fish'], ['allergy-egg', 'Egg'], ['allergy-dairy', 'Dairy'],
    ['allergy-gluten', 'Gluten / coeliac'], ['allergy-soy', 'Soy'], ['allergy-sesame', 'Sesame'] ] },
  { group: 'Diet', kind: 'diet', tags: [
    ['diet-vegetarian', 'Vegetarian'], ['diet-vegan', 'Vegan'], ['diet-pescatarian', 'Pescatarian'],
    ['diet-halal', 'Halal'], ['diet-kosher', 'Kosher'], ['diet-gluten-free', 'Gluten-free'], ['diet-dairy-free', 'Dairy-free'] ] },
  { group: 'Seating and service', kind: 'service', tags: [
    ['svc-quiet', 'Quiet table'], ['svc-window', 'Window seat'], ['svc-booth', 'Booth'],
    ['svc-outdoor', 'Outdoor seating'], ['svc-high-chair', 'High chair'], ['svc-wheelchair', 'Wheelchair access'] ] },
];
const ALLOWED_TAGS = new Set(TAG_GROUPS.flatMap(g => g.tags.map(([id]) => id))); // built-in tags
// Tags a manager adds from inside the app are stored in the custom_tags table.
const allCustomTags = () => db.prepare('SELECT id, kind, label FROM custom_tags ORDER BY label COLLATE NOCASE').all();
const isKnownTag = id => ALLOWED_TAGS.has(id) || !!db.prepare('SELECT 1 FROM custom_tags WHERE id = ?').get(id);
function tagsForApi() {
  const custom = allCustomTags();
  return TAG_GROUPS.map(g => ({
    group: g.group, kind: g.kind,
    tags: g.tags.map(([id, label]) => ({ id, label, custom: false }))
      .concat(custom.filter(c => c.kind === g.kind).map(c => ({ id: c.id, label: c.label, custom: true }))),
  }));
}

// Returns { value: null } when the request has no "tags" (leave them unchanged),
// { value: [ids] } when valid, or { error } for anything not on the list.
function parseTags(body) {
  if (body.tags === undefined) return { value: null };
  if (!Array.isArray(body.tags) || body.tags.length > 40) return { error: 'tags must be a list of known tags' };
  const out = [];
  for (const t of body.tags) {
    if (typeof t !== 'string' || !isKnownTag(t)) return { error: 'unknown tag' };
    if (!out.includes(t)) out.push(t);
  }
  return { value: out };
}

function setTags(guestId, tags) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM guest_tags WHERE guest_id = ?').run(guestId);
    const ins = db.prepare('INSERT INTO guest_tags (guest_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(guestId, t);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function parseGuest(body) {
  const name = text(body.name);
  const phone = (typeof body.phone === 'string' ? body.phone : '').replace(/[\s-]/g, '');
  const email = text(body.email);
  const notes = text(body.notes);
  if (!name || name.length > 100) return { error: 'name is required (max 100 characters)' };
  if (!/^\d{10}$/.test(phone)) return { error: 'phone must be exactly 10 digits' };
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return { error: 'email is not valid' };
  if (notes.length > 1000) return { error: 'notes are too long (max 1000 characters)' };
  const tags = parseTags(body);
  if (tags.error) return { error: tags.error };
  return { value: { name, phone, email, notes, tags: tags.value } };
}

// ---- Sessions (in memory: a server restart signs everyone out) ----
const SESSION_IDLE_MS = 30 * 60 * 1000;      // signed out after 30 min with no requests
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;  // and never longer than 12 hours in total
const sessions = new Map();                  // token -> { staffId, name, role, createdAt, lastSeen }

function createSession(staff) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { staffId: staff.id, name: staff.name, role: staff.role, createdAt: now, lastSeen: now });
  return token;
}
function lookupSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = now;
  return s;
}
function endSessionsFor(staffId) {
  for (const [token, s] of sessions) if (s.staffId === staffId) sessions.delete(token);
}
function bearerToken(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers['authorization'] || '');
  return m ? m[1] : null;
}

// ---- Failed-login lockout ----
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_ADDRESS = 20;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, first, lockedUntil }

function lockRemainingMs(key) {
  const f = failures.get(key);
  return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0;
}
function recordFailure(key, max) {
  const now = Date.now();
  let f = failures.get(key);
  if (!f || (!f.lockedUntil && now - f.first > FAIL_WINDOW_MS) || (f.lockedUntil && f.lockedUntil <= now)) {
    f = { count: 0, first: now, lockedUntil: 0 };
    failures.set(key, f);
  }
  f.count += 1;
  if (f.count >= max) f.lockedUntil = now + LOCK_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) sessions.delete(t);
  }
  for (const [k, f] of failures) {
    if (f.lockedUntil ? f.lockedUntil <= now : now - f.first > FAIL_WINDOW_MS) failures.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ---- Authentication gate for the whole API ----
const staffCount = () => db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  const open =
    (req.method === 'GET' && req.path === '/api/staff') ||                 // names for the login dropdown
    (req.method === 'POST' && req.path === '/api/staff/login') ||          // login itself
    (req.method === 'POST' && req.path === '/api/staff' && staffCount() === 0); // first-ever account
  if (open) return next();

  const token = bearerToken(req);
  const session = token && lookupSession(token);
  if (!session) return res.status(401).json({ error: 'not signed in' });
  // Name and role are re-read on every request, so a role change or removal applies immediately.
  const current = db.prepare('SELECT name, role FROM staff WHERE id = ?').get(session.staffId);
  if (!current) { sessions.delete(token); return res.status(401).json({ error: 'not signed in' }); }
  session.name = current.name;
  session.role = current.role;
  req.session = session;
  req.token = token;
  next();
});

// ---- Staff endpoints ----
// PINs (and their hashes) are never sent to the client. Login is verified here.
const managerCount = () => db.prepare("SELECT COUNT(*) AS c FROM staff WHERE role = 'manager'").get().c;

function requireManager(req, res, next) {
  if (!req.session || req.session.role !== 'manager') {
    return res.status(403).json({ error: 'only a manager can do that' });
  }
  next();
}

// Plain-text record in the server window of who did what (manager-only actions).
// Audit trail: printed in the server window AND saved in the database so it
// survives restarts. Never put guest names or phone numbers in the message.
function record(actor, role, message) {
  const at = new Date().toISOString();
  console.log(`[audit] ${at} ${actor}${role ? ' (' + role + ')' : ''}: ${message}`);
  try {
    db.prepare('INSERT INTO audit_log (at, actor, role, action) VALUES (?, ?, ?, ?)')
      .run(at, actor, role || null, message);
  } catch (e) { console.log('[audit] could not save to database:', e.message); }
}
const audit = (req, message) =>
  req.session ? record(req.session.name, req.session.role, message) : record('first-run setup', null, message);

// Names only: used to fill the login dropdown before anyone has signed in.
app.get('/api/staff', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM staff').all());
});

// Who am I? Lets the app refresh the signed-in person's current role.
app.get('/api/me', (req, res) => {
  res.json({ id: req.session.staffId, name: req.session.name, role: req.session.role });
});

// Full staff list with roles (managers only).
app.get('/api/staff/all', requireManager, (req, res) => {
  res.json(db.prepare('SELECT id, name, role FROM staff ORDER BY rowid').all());
});

// ---- Backups ----
// A backup is a complete, consistent copy of the database made with SQLite's own
// VACUUM INTO (safe while the server is running, unlike copying the file by hand).
// It holds guest details and staff PIN hashes, so the folder must be protected and
// kept out of GitHub. Managers can also download a copy from the app.
const fs = require('fs');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 14);   // newest copies kept
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;                                    // automatic: once a day
const BACKUP_NAME = /^guestbook-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(n => BACKUP_NAME.test(n)).sort().reverse().map(name => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, at: st.mtime.toISOString() };
    });
  } catch (e) { return []; }
}

function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  let name = `guestbook-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
  let file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) { // two backups in the same second: wait it out by adding a suffix-free retry
    const t = Date.now() + 1100; while (Date.now() < t) { /* brief wait */ }
    return makeBackup();
  }
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  try { fs.chmodSync(file, 0o600); } catch (e) {}
  // Check the copy opens and has the expected tables before trusting it.
  const copy = new DatabaseSync(file);
  try { copy.prepare('SELECT COUNT(*) AS c FROM guests').get(); copy.prepare('SELECT COUNT(*) AS c FROM staff').get(); }
  finally { copy.close(); }
  // Keep only the newest BACKUP_KEEP copies.
  for (const old of listBackups().slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (e) {}
  }
  return { name, size: fs.statSync(file).size, at: new Date().toISOString() };
}

function autoBackup() {
  try {
    if (staffCount() === 0) return;            // nothing worth saving yet
    const latest = listBackups()[0];
    if (!latest || Date.now() - new Date(latest.at).getTime() >= BACKUP_EVERY_MS) {
      const b = makeBackup();
      record('system', null, 'Automatic backup saved (' + b.name + ')');
    }
  } catch (e) { console.log('[backup] automatic backup failed:', e.message); }
}

app.get('/api/backups', requireManager, (req, res) => {
  res.json({ keep: BACKUP_KEEP, items: listBackups() });
});

app.post('/api/backups', requireManager, (req, res) => {
  try {
    const b = makeBackup();
    audit(req, 'Created a backup (' + b.name + ')');
    res.status(201).json(b);
  } catch (e) {
    console.log('[backup] failed:', e.message);
    res.status(500).json({ error: 'backup failed' });
  }
});

app.get('/api/backups/:name/download', requireManager, (req, res) => {
  const name = req.params.name;
  if (!BACKUP_NAME.test(name)) return res.status(400).json({ error: 'invalid backup name' });
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'backup not found' });
  audit(req, 'Downloaded a backup (' + name + ')');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.setHeader('Content-Length', fs.statSync(file).size);
  fs.createReadStream(file).pipe(res);
});

// ---- Activity log housekeeping ----
// Entries older than AUDIT_KEEP_DAYS (default 365, minimum 30) are removed once a day.
// Before they are removed they are appended to audit-archive.csv in the backups folder,
// so a record is kept off the live database. The trim itself is written to the log.
const AUDIT_KEEP_DAYS = Math.max(30, parseInt(process.env.AUDIT_KEEP_DAYS, 10) || 365);
const csvCell = v => { const t = String(v == null ? '' : v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const csvRow = r => [r.id, r.at, r.actor, r.role, r.action].map(csvCell).join(',') + '\r\n';
const CSV_HEADER = 'id,at,actor,role,action\r\n';

function trimAuditLog() {
  try {
    const cutoff = new Date(Date.now() - AUDIT_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const old = db.prepare('SELECT id, at, actor, role, action FROM audit_log WHERE at < ? ORDER BY id').all(cutoff);
    if (!old.length) return 0;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const archive = path.join(BACKUP_DIR, 'audit-archive.csv');
    const isNew = !fs.existsSync(archive);
    fs.appendFileSync(archive, (isNew ? CSV_HEADER : '') + old.map(csvRow).join(''), { mode: 0o600 });
    // Only delete once the copy is safely written.
    db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff);
    record('system', null, `Activity log trimmed: ${old.length} entries older than ${AUDIT_KEEP_DAYS} days moved to audit-archive.csv`);
    return old.length;
  } catch (e) { console.log('[audit] trim failed:', e.message); return 0; }
}

// Whole log as a CSV file (managers only).
app.get('/api/audit/export', requireManager, (req, res) => {
  const rows = db.prepare('SELECT id, at, actor, role, action FROM audit_log ORDER BY id').all();
  audit(req, 'Downloaded the activity log as CSV');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity-log.csv"');
  res.send(CSV_HEADER + rows.map(csvRow).join(''));
});

app.get('/api/audit', requireManager, (req, res) => {
  res.json(db.prepare('SELECT id, at, actor, role, action FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

app.post('/api/staff', (req, res) => {
  const isFirst = staffCount() === 0; // the very first account may be created without signing in
  if (!isFirst && !(req.session && req.session.role === 'manager')) {
    return res.status(403).json({ error: 'only a manager can do that' });
  }
  const body = bodyOf(req);
  const name = text(body.name);
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const requestedRole = body.role === undefined ? 'staff' : body.role;
  if (!name || name.length > 50) return res.status(400).json({ error: 'name is required (max 50 characters)' });
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
  if (!ROLES.includes(requestedRole)) return res.status(400).json({ error: 'role must be manager or staff' });
  const dup = db.prepare('SELECT id FROM staff WHERE lower(name) = lower(?)').get(name);
  if (dup) return res.status(409).json({ error: 'a staff member with that name already exists' });

  const role = isFirst ? 'manager' : requestedRole; // the first account is always the manager
  const id = uid('s');
  db.prepare('INSERT INTO staff (id, name, pin, role) VALUES (?, ?, ?, ?)').run(id, name, hashPin(pin), role);
  audit(req, `created ${role} account "${name}"`);
  const result = { id, name, role };
  if (isFirst) result.token = createSession(result); // first account signs in straight away
  res.status(201).json(result);
});

app.post('/api/staff/login', (req, res) => {
  const body = bodyOf(req);
  const id = typeof body.id === 'string' ? body.id : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const accountKey = 'account:' + id;
  const addressKey = 'address:' + ip;

  const wait = Math.max(lockRemainingMs(accountKey), lockRemainingMs(addressKey));
  if (wait > 0) {
    const retryAfterSeconds = Math.ceil(wait / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'too many failed attempts', retryAfterSeconds });
  }

  const staff = ID_RE.test(id) ? db.prepare('SELECT id, name, pin, role FROM staff WHERE id = ?').get(id) : null;
  if (!staff || !pin || pin.length > 20 || !verifyPin(pin, staff.pin)) {
    recordFailure(accountKey, MAX_FAILS_PER_ACCOUNT);
    recordFailure(addressKey, MAX_FAILS_PER_ADDRESS);
    if (lockRemainingMs(accountKey) > 0 || lockRemainingMs(addressKey) > 0) {
      console.log(`[security] ${new Date().toISOString()} login locked for ${id || '(none)'} from ${ip}`);
      record(staff ? staff.name : 'unknown account', staff ? staff.role : null, 'sign-in locked after too many wrong PINs');
    }
    return res.status(401).json({ error: 'incorrect PIN' });
  }

  failures.delete(accountKey);
  record(staff.name, staff.role, 'signed in');
  res.json({ id: staff.id, name: staff.name, role: staff.role, token: createSession(staff) });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.token);
  res.status(204).end();
});

// Change someone's role (managers only). There must always be at least one manager.
app.put('/api/staff/:id/role', requireManager, (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const target = db.prepare('SELECT id, name, role FROM staff WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'staff member not found' });
  const role = bodyOf(req).role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'role must be manager or staff' });
  if (target.role === 'manager' && role !== 'manager' && managerCount() <= 1) {
    return res.status(400).json({ error: 'there must be at least one manager' });
  }
  db.prepare('UPDATE staff SET role = ? WHERE id = ?').run(role, target.id);
  audit(req, `changed ${target.name} from ${target.role} to ${role}`);
  res.json({ id: target.id, name: target.name, role });
});

app.delete('/api/staff/:id', requireManager, (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const target = db.prepare('SELECT id, name, role FROM staff WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'staff member not found' });
  if (target.id === req.session.staffId) return res.status(400).json({ error: 'you cannot remove your own account' });
  if (target.role === 'manager' && managerCount() <= 1) return res.status(400).json({ error: 'there must be at least one manager' });
  db.prepare('DELETE FROM staff WHERE id = ?').run(target.id);
  endSessionsFor(target.id); // removed staff are signed out immediately
  audit(req, `removed ${target.role} account "${target.name}"`);
  res.status(204).end();
});

// ---- Guest endpoints ----
function guestWithChildren(guestRow, tagsPre) {
  const visits = db.prepare('SELECT id, date, note, logged_by AS loggedBy FROM visits WHERE guest_id = ? ORDER BY date DESC').all(guestRow.id);
  const occasions = db.prepare('SELECT id, type, date FROM occasions WHERE guest_id = ?').all(guestRow.id);
  const tags = tagsPre || db.prepare('SELECT tag FROM guest_tags WHERE guest_id = ? ORDER BY tag').all(guestRow.id).map(r => r.tag);
  return { ...guestRow, visits, occasions, tags };
}


// ---- Suggest tags from existing free-text notes (one-off conversion, manager only) ----
// Allergy tags are only suggested when the note also mentions an allergy/intolerance,
// so "likes peanut sauce" is not treated as an allergy. Words are matched loosely.
const ALLERGY_CONTEXT = /allerg|intoleran|anaphyla|epipen|coeliac|celiac|cannot eat|can't eat|\bno\s/i;
const NOTE_RULES = [
  ['allergy-peanut', /peanut|groundnut|\bnuts?\s+allerg|nut\s+allerg|allerg\w*\s+(to\s+)?nuts?\b/i, true],
  ['allergy-tree-nut', /tree\s*nut|almond|cashew|walnut|hazelnut|pistachio|pecan|\bnuts?\s+allerg|nut\s+allerg|allerg\w*\s+(to\s+)?nuts?\b/i, true],
  ['allergy-shellfish', /shellfish|prawn|shrimp|crab|lobster|crustacean/i, true],
  ['allergy-fish', /\bfish\b(?!\s*free)/i, true],
  ['allergy-egg', /\beggs?\b/i, true],
  ['allergy-dairy', /dairy|lactose|\bmilk\b/i, true],
  ['allergy-gluten', /gluten|coeliac|celiac|\bwheat\b/i, true],
  ['allergy-soy', /\bsoy\w*/i, true],
  ['allergy-sesame', /sesame/i, true],
  ['diet-vegetarian', /vegetarian|veggie/i, false],
  ['diet-vegan', /\bvegan/i, false],
  ['diet-pescatarian', /pescatarian|pescetarian/i, false],
  ['diet-halal', /\bhalal/i, false],
  ['diet-kosher', /\bkosher/i, false],
  ['diet-gluten-free', /gluten[\s-]*free/i, false],
  ['diet-dairy-free', /dairy[\s-]*free|lactose[\s-]*free/i, false],
  ['svc-quiet', /\bquiet/i, false],
  ['svc-window', /\bwindow/i, false],
  ['svc-booth', /\bbooth/i, false],
  ['svc-outdoor', /outdoor|outside|\bpatio|\bterrace/i, false],
  ['svc-high-chair', /high\s*chair|highchair|booster/i, false],
  ['svc-wheelchair', /wheel\s*chair|wheelchair/i, false],
];
function suggestTagsFromNotes(notes) {
  const n = String(notes || '');
  if (!n) return [];
  const hasCtx = ALLERGY_CONTEXT.test(n);
  const out = [];
  for (const [tag, re, needsCtx] of NOTE_RULES) {
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (needsCtx && !hasCtx) continue;
    if (re.test(n)) out.push(tag);
  }
  // "gluten free" / "dairy free" are diets, not allergies, unless an allergy is also stated
  if (/gluten[\s-]*free/i.test(n) && !/allerg|coeliac|celiac|intoleran/i.test(n)) { const i = out.indexOf('allergy-gluten'); if (i >= 0) out.splice(i, 1); }
  if (/(dairy|lactose)[\s-]*free/i.test(n) && !/allerg|intoleran/i.test(n)) { const i = out.indexOf('allergy-dairy'); if (i >= 0) out.splice(i, 1); }
  return out;
}

// POST /api/tags/from-notes  { apply: false } = preview only, { apply: true } = save the tags.
// Only ADDS tags; existing tags and the notes themselves are never changed.
app.post('/api/tags/from-notes', requireManager, (req, res) => {
  const apply = !!(req.body && req.body.apply === true);
  const rows = db.prepare('SELECT id, notes FROM guests').all();
  const existing = db.prepare('SELECT guest_id, tag FROM guest_tags').all();
  const have = new Set(existing.map(r => r.guest_id + '|' + r.tag));
  const perTag = {};
  let guests = 0, added = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO guest_tags (guest_id, tag) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const g of rows) {
      const fresh = suggestTagsFromNotes(g.notes).filter(t => !have.has(g.id + '|' + t));
      if (!fresh.length) continue;
      guests++;
      for (const t of fresh) { perTag[t] = (perTag[t] || 0) + 1; added++; if (apply) ins.run(g.id, t); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'could not add tags' }); }
  if (apply) audit(req, `added ${added} tags to ${guests} guests from their notes`);
  res.json({ applied: apply, guests, added, perTag });
});

app.get('/api/tags', (req, res) => {
  res.json(tagsForApi());
});

// ---- Managers add, rename and remove their own tags (built-in tags are fixed) ----
const MAX_CUSTOM_TAGS = 60;
function cleanTagLabel(v) {
  const label = (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim();
  if (label.length < 2 || label.length > 30) return { error: 'tag name must be 2 to 30 characters' };
  if (/[<>\u0000-\u001f]/.test(label)) return { error: 'tag name has characters that are not allowed' };
  return { label };
}
const labelTaken = (label, exceptId) =>
  tagsForApi().some(g => g.tags.some(t => t.id !== exceptId && t.label.toLowerCase() === label.toLowerCase()));

app.get('/api/tags/usage', requireManager, (req, res) => {
  const rows = db.prepare('SELECT tag, COUNT(*) AS n FROM guest_tags GROUP BY tag').all();
  const out = {}; for (const r of rows) out[r.tag] = r.n;
  res.json(out);
});

app.post('/api/tags', requireManager, (req, res) => {
  const b = req.body || {};
  const g = TAG_GROUPS.find(x => x.kind === b.kind);
  if (!g) return res.status(400).json({ error: 'choose a group for the tag' });
  const c = cleanTagLabel(b.label);
  if (c.error) return res.status(400).json({ error: c.error });
  if (labelTaken(c.label, null)) return res.status(409).json({ error: 'a tag with that name already exists' });
  if (allCustomTags().length >= MAX_CUSTOM_TAGS) return res.status(400).json({ error: 'too many custom tags' });
  const id = 'custom-' + g.kind + '-' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO custom_tags (id, kind, label) VALUES (?, ?, ?)').run(id, g.kind, c.label);
  audit(req, `added the tag "${c.label}" to ${g.group}`);
  res.status(201).json({ id, kind: g.kind, label: c.label });
});

app.put('/api/tags/:id', requireManager, (req, res) => {
  const row = db.prepare('SELECT id, label FROM custom_tags WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: ALLOWED_TAGS.has(req.params.id) ? 'built-in tags cannot be renamed' : 'tag not found' });
  const c = cleanTagLabel((req.body || {}).label);
  if (c.error) return res.status(400).json({ error: c.error });
  if (labelTaken(c.label, row.id)) return res.status(409).json({ error: 'a tag with that name already exists' });
  db.prepare('UPDATE custom_tags SET label = ? WHERE id = ?').run(c.label, row.id);
  audit(req, `renamed the tag "${row.label}" to "${c.label}"`);
  res.json({ id: row.id, label: c.label });
});

app.delete('/api/tags/:id', requireManager, (req, res) => {
  const row = db.prepare('SELECT id, label FROM custom_tags WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: ALLOWED_TAGS.has(req.params.id) ? 'built-in tags cannot be removed' : 'tag not found' });
  let n = 0;
  db.exec('BEGIN');
  try {
    n = db.prepare('DELETE FROM guest_tags WHERE tag = ?').run(row.id).changes;
    db.prepare('DELETE FROM custom_tags WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'could not remove the tag' }); }
  audit(req, `removed the tag "${row.label}" (was on ${n} guest${n === 1 ? '' : 's'})`);
  res.json({ removed: true, guests: Number(n) });
});

app.get('/api/guests', (req, res) => {
  const rows = db.prepare('SELECT * FROM guests').all();
  const tagMap = new Map();
  for (const r of db.prepare('SELECT guest_id, tag FROM guest_tags ORDER BY tag').all()) {
    if (!tagMap.has(r.guest_id)) tagMap.set(r.guest_id, []);
    tagMap.get(r.guest_id).push(r.tag);
  }
  res.json(rows.map(g => guestWithChildren(g, tagMap.get(g.id) || [])));
});

app.post('/api/guests', (req, res) => {
  const parsed = parseGuest(bodyOf(req));
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { name, phone, email, notes, tags } = parsed.value;
  const id = uid('g');
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO guests (id, name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, phone, email, notes, created_at);
  if (tags && tags.length) setTags(id, tags);
  res.status(201).json(guestWithChildren({ id, name, phone, email, notes, created_at }));
});

app.put('/api/guests/:id', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const existing = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'guest not found' });
  const parsed = parseGuest(bodyOf(req));
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { name, phone, email, notes, tags } = parsed.value;
  db.prepare('UPDATE guests SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?')
    .run(name, phone, email, notes, req.params.id);
  if (tags !== null) setTags(req.params.id, tags); // no "tags" in the request = leave them as they are
  res.json(guestWithChildren({ ...existing, name, phone, email, notes }));
});

app.delete('/api/guests/:id', requireManager, (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const guest = db.prepare('SELECT name FROM guests WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM guests WHERE id = ?').run(req.params.id);
  if (guest) audit(req, `deleted guest ${req.params.id}`);
  res.status(204).end();
});

app.post('/api/guests/:id/visits', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'guest not found' });
  const body = bodyOf(req);
  const date = typeof body.date === 'string' ? body.date : '';
  const note = text(body.note);
  if (!validDate(date)) return res.status(400).json({ error: 'date must be a valid date (YYYY-MM-DD)' });
  if (note.length > 500) return res.status(400).json({ error: 'note is too long (max 500 characters)' });
  const id = uid('v');
  const loggedBy = req.session.name; // taken from the signed-in session, never from the request
  db.prepare('INSERT INTO visits (id, guest_id, date, note, logged_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, date, note, loggedBy);
  res.status(201).json({ id, date, note, loggedBy });
});

app.post('/api/guests/:id/occasions', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(req.params.id);
  if (!guest) return res.status(404).json({ error: 'guest not found' });
  const body = bodyOf(req);
  const type = typeof body.type === 'string' ? body.type : '';
  const date = typeof body.date === 'string' ? body.date : '';
  if (!OCCASION_TYPES.includes(type)) return res.status(400).json({ error: 'type must be Birthday, Anniversary or Other' });
  if (!validDate(date)) return res.status(400).json({ error: 'date must be a valid date (YYYY-MM-DD)' });
  const id = uid('o');
  db.prepare('INSERT INTO occasions (id, guest_id, type, date) VALUES (?, ?, ?, ?)')
    .run(id, req.params.id, type, date);
  res.status(201).json({ id, type, date });
});

// ---- Not found / error handling (no stack traces or internals sent to clients) ----
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(404).type('text/plain').send('Not found');
});

app.use((err, req, res, next) => {
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'server error' : 'bad request' });
});

// ---- Optional HTTPS --------------------------------------------------------
// If a certificate and key are provided, the server speaks HTTPS. Provide them
// either with the TLS_CERT and TLS_KEY environment variables, or by placing
// certs/cert.pem and certs/key.pem in the project folder. With neither, it runs
// as plain HTTP (fine for first tests, not for real use).
// If you provide only one of the two, or a file cannot be read, the server stops
// with a clear message instead of quietly falling back to HTTP.
function loadTls() {
  const certPath = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
  const keyPath  = process.env.TLS_KEY  || path.join(__dirname, 'certs', 'key.pem');
  const explicit = !!(process.env.TLS_CERT || process.env.TLS_KEY);
  const haveCert = fs.existsSync(certPath), haveKey = fs.existsSync(keyPath);
  if (!explicit && !haveCert && !haveKey) return null;
  if (!haveCert || !haveKey) {
    console.error('HTTPS setup is incomplete. Need BOTH files:');
    console.error('  certificate: ' + certPath + (haveCert ? '' : '   <-- missing'));
    console.error('  key:         ' + keyPath + (haveKey ? '' : '   <-- missing'));
    process.exit(1);
  }
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (e) {
    console.error('Could not read the HTTPS files: ' + e.message);
    process.exit(1);
  }
}
const tlsOptions = loadTls();
const SCHEME = tlsOptions ? 'https' : 'http';

const onListening = () => {
  console.log(`Guest Book server running on port ${PORT} (${tlsOptions ? 'HTTPS' : 'plain HTTP - not encrypted'})`);
  console.log(`On this computer: ${SCHEME}://localhost:${PORT}`);
  console.log(`From phones/tablets on the same Wi-Fi, type ONE of these (start with ${SCHEME}://):`);
  const nets = require('os').networkInterfaces();
  let found = false;
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`  ${SCHEME}://${n.address}:${PORT}    (adapter: ${name})`);
        found = true;
      }
    }
  }
  if (!found) console.log('  No network connection found - connect this computer to Wi-Fi first.');
  console.log('Use the one for your Wi-Fi adapter, not virtual ones (WSL, VirtualBox, Hyper-V, VPN).');
  if (!tlsOptions) console.log('WARNING: PINs and guest data are NOT encrypted on the network. See README, "HTTPS".');
  console.log(`Activity log: entries older than ${AUDIT_KEEP_DAYS} days are archived and removed daily.`);
  console.log(`Backups: ${BACKUP_DIR} (automatic every 24 hours, newest ${BACKUP_KEEP} kept)`);
  if (staffCount() === 0) console.log('No staff accounts yet: open the app and create the first account now.');
};

if (tlsOptions) require('https').createServer(tlsOptions, app).listen(PORT, '0.0.0.0', onListening);
else app.listen(PORT, '0.0.0.0', onListening);

// Take a backup now if none exists in the last 24 hours, then check once an hour.
autoBackup();
setInterval(autoBackup, 60 * 60 * 1000).unref();

// Trim the activity log at start-up, then once a day.
trimAuditLog();
setInterval(trimAuditLog, 24 * 60 * 60 * 1000).unref();
