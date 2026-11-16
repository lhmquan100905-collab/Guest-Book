// Restore the Guest Book database from a backup.
//
//   1. Stop the server (close its window / Ctrl+C).
//   2. node scripts/restore-backup.js backups/guestbook-2026-11-16-020000.db
//   3. Start the server again: node server.js
//
// The current database is kept as guestbook.before-restore-<time>.db, so a
// restore can itself be undone. Nothing is deleted.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/restore-backup.js <backup file>'); process.exit(1); }
if (!fs.existsSync(src)) { console.error('Backup file not found: ' + src); process.exit(1); }

// Check the backup is a real Guest Book database before touching anything.
let guests, staff;
try {
  const b = new DatabaseSync(path.resolve(src), { readOnly: true });
  guests = b.prepare('SELECT COUNT(*) AS c FROM guests').get().c;
  staff  = b.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
  b.close();
} catch (e) { console.error('That file is not a usable Guest Book backup: ' + e.message); process.exit(1); }

const live = path.join(__dirname, '..', 'guestbook.db');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
for (const ext of ['', '-wal', '-shm', '-journal']) {
  const f = live + ext;
  if (fs.existsSync(f)) {
    if (ext === '') fs.copyFileSync(f, path.join(__dirname, '..', 'guestbook.before-restore-' + stamp + '.db'));
    fs.unlinkSync(f);   // stale write-ahead files must not be mixed with the restored file
  }
}
fs.copyFileSync(src, live);
console.log(`Restored ${path.basename(src)}: ${guests} guests, ${staff} staff accounts.`);
console.log('Start the server again with: node server.js');
