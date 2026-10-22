// Import legacy guest data (CSV) into the Guest Book database.
//
// Usage:
//   node scripts/import-guests.js path/to/guests.csv
//
// Expected CSV columns (header row required):
//   guest_id,name,phone,first_visit,last_visit,visit_count,birthday,anniversary,notes
//
// - birthday / anniversary are MM-DD (no year) — stored with a placeholder
//   year since the app only reads month and day.
// - first_visit / last_visit become two "imported" visit records rather
//   than fabricating visit_count individual visits that never happened.
// - Guests are matched on name + phone to avoid creating duplicates if the
//   script is run more than once.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/import-guests.js path/to/guests.csv');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`Could not find the CSV file: ${csvPath}`);
  console.error('Check the file name and that you are running this from the project folder.');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'guestbook.db');
const db = new DatabaseSync(dbPath);

// Make sure the tables exist (same schema as server.js), so this script works
// even if the server has never been started on this machine.
db.exec(`
  CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, notes TEXT);
  CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE, date TEXT NOT NULL, note TEXT, logged_by TEXT);
  CREATE TABLE IF NOT EXISTS occasions (id TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE, type TEXT NOT NULL, date TEXT NOT NULL);
`);
// Older databases may not have the created_at column yet.
const guestCols = db.prepare('PRAGMA table_info(guests)').all().map(c => c.name);
if (!guestCols.includes('created_at')) {
  db.exec('ALTER TABLE guests ADD COLUMN created_at TEXT');
  db.prepare('UPDATE guests SET created_at = ? WHERE created_at IS NULL').run(new Date().toISOString());
}
const uid = (prefix) => prefix + '-' + crypto.randomBytes(5).toString('hex');

function isValidPhone(phone) {
  return /^\d{10}$/.test(String(phone).replace(/[\s-]/g, ''));
}

// Minimal RFC4180-style CSV line parser (handles quoted fields with commas).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else { field += c; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(raw);
const header = rows[0];
const idx = (name) => header.indexOf(name);
const col = { name: idx('name'), phone: idx('phone'), first: idx('first_visit'), last: idx('last_visit'), count: idx('visit_count'), bday: idx('birthday'), anniv: idx('anniversary'), notes: idx('notes') };

const PLACEHOLDER_YEAR = '2024';
const toOccasionDate = (mmdd) => mmdd ? `${PLACEHOLDER_YEAR}-${mmdd}` : null;

let created = 0, skippedDup = 0, skippedBadPhone = 0;

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 2) continue;
  const name = (row[col.name] || '').trim();
  const phone = (row[col.phone] || '').trim();
  if (!name) continue;

  const existing = db.prepare('SELECT id FROM guests WHERE name = ? AND phone = ?').get(name, phone);
  if (existing) { skippedDup++; continue; }

  if (phone && !isValidPhone(phone)) { skippedBadPhone++; console.warn(`Skipped (bad phone): ${name} - "${phone}"`); continue; }

  const notes = (row[col.notes] || '').trim();
  const firstVisit = (row[col.first] || '').trim();
  const lastVisit = (row[col.last] || '').trim();
  const visitCount = (row[col.count] || '').trim();

  const id = uid('g');
  const created_at = firstVisit ? new Date(firstVisit).toISOString() : new Date().toISOString();
  db.prepare('INSERT INTO guests (id, name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, phone, '', notes, created_at);

  if (firstVisit) {
    db.prepare('INSERT INTO visits (id, guest_id, date, note, logged_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid('v'), id, firstVisit, `Imported record — first recorded visit in previous system (${visitCount || '?'} total visits recorded)`, 'Import');
  }
  if (lastVisit && lastVisit !== firstVisit) {
    db.prepare('INSERT INTO visits (id, guest_id, date, note, logged_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid('v'), id, lastVisit, `Imported record — most recent of ${visitCount || '?'} total visits recorded in previous system`, 'Import');
  }

  const bday = toOccasionDate((row[col.bday] || '').trim());
  if (bday) db.prepare('INSERT INTO occasions (id, guest_id, type, date) VALUES (?, ?, ?, ?)').run(uid('o'), id, 'Birthday', bday);

  const anniv = toOccasionDate((row[col.anniv] || '').trim());
  if (anniv) db.prepare('INSERT INTO occasions (id, guest_id, type, date) VALUES (?, ?, ?, ?)').run(uid('o'), id, 'Anniversary', anniv);

  created++;
}

console.log(`\nImport complete.`);
console.log(`  Created: ${created}`);
console.log(`  Skipped (already existed): ${skippedDup}`);
console.log(`  Skipped (invalid phone): ${skippedBadPhone}`);
