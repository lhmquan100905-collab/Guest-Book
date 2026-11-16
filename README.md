# Guest Book — shared backend and database

This is the real client-server-database version of the Guest Book prototype,
matching the architecture in the system proposal (Section 4):

```
[FOH Tablet App] <--> [Express API / Server] <--> [SQLite Database]
```

Every tablet talks to the **same server**, which reads and writes the
**same database file** — so guest records, visits, occasions, and staff
accounts are genuinely shared and always up to date on every device.

## What's included

- `server.js` — the Express API and database logic
- `public/index.html` — the tablet app (same UI as before, now calling the API instead of local storage)
- `guestbook.db` — created automatically the first time you run the server

## 1. Install Node.js

Download and install Node.js version 22 or later from https://nodejs.org if you don't already have it. This project uses Node's built-in SQLite support, so there's no separate database software to install and nothing to compile.

## 2. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

This downloads Express (the web server) — that's it. No compiler or build tools required.

## 3. Start the server

```
npm start
```

You should see:

```
Guest Book server running on port 3000
On this computer: http://localhost:3000
From tablets on the same Wi-Fi: http://<this computer's LAN IP>:3000
```

Leave this running — it's the "backend" that all tablets connect to. In a
real deployment this would run on a small always-on machine (a mini PC or
an old laptop) plugged in near the POS system.

## 4. Find this computer's LAN IP address

The tablets need this computer's address on your local Wi-Fi network:

- **Windows**: open Command Prompt, run `ipconfig`, look for "IPv4 Address" (e.g. `192.168.1.42`)
- **Mac**: System Settings → Wi-Fi → Details, or run `ipconfig getifaddr en0` in Terminal
- **Linux**: run `hostname -I` in a terminal

## 5. Connect the tablets

Make sure every tablet is on the **same Wi-Fi network** as the computer
running the server. Then, in each tablet's browser, go to:

```
http://<the LAN IP from step 4>:3000
```

For example: `http://192.168.1.42:3000`

Every tablet loading that address is now looking at the same live data.
Log a visit on one tablet and it appears instantly on the others (after a
refresh or re-navigating within the app).

## How it's structured (for your report)

- **Database**: SQLite, a real relational database, with four tables —
  `staff`, `guests`, `visits`, and `occasions` — linked by foreign keys
  (a visit or occasion belongs to exactly one guest).
- **Backend**: a small REST API in Express. Each action the tablet app
  takes (search, add guest, log visit, add occasion, manage staff) maps to
  one HTTP endpoint, documented in `server.js`.
- **Frontend**: the same tablet interface as before, but it now calls
  `fetch('/api/...')` instead of reading and writing browser storage.

## Upgrading from an earlier version

- Your existing `guestbook.db` keeps working: guests, visits, occasions and
  staff accounts (with their hashed PINs) are all unchanged.
- **Everyone is asked to sign in again** after the update, because sign-in
  sessions are now held by the server. Restarting the server also signs
  everyone out.
- Tablets and phones may still show the old page: reload with the cache
  cleared (or close and reopen the tab) once after updating.
- **Roles:** the database gets a `role` column automatically. The earliest
  existing account becomes the **manager** and every other account becomes
  **floor staff** (PINs unchanged). A manager can change anyone's role in
  "Manage staff". Everyone signs in again after this update.
- Staff accounts made before the hashed-PIN update (plain-text PINs) still
  cannot sign in. Delete those rows (or the whole database, if it only holds
  test data) and recreate the accounts in "Manage staff".

## Security (what protects the data)

| Protection | How it works |
|---|---|
| **Sign-in required for all data** | Every guest and staff request needs a valid session token. Without one the server answers `401` and returns nothing. Only the staff-name list (for the login dropdown) and the login itself are open. |
| **Server-side sessions** | After a correct PIN the server issues a random 256-bit token. Sessions end after 30 minutes with no activity, after 12 hours in total, on sign-out, or when that staff member is removed. |
| **Login lockout** | 5 wrong PINs lock that account for 15 minutes (20 failures lock the sender's address). The lockout is logged in the server window. Other staff are not affected. |
| **PIN rules** | 4 to 6 digits only (6 recommended). PINs are salted and hashed with scrypt and never sent to the browser. PIN boxes are masked on screen. |
| **No open CORS** | The app is served by the same server, so other websites cannot read the API from a browser. |
| **Server-side validation** | Names, phone (exactly 10 digits), email, notes, dates, occasion types and ID formats are all checked on the server. Bad input gets a `400` with a short message and no internal details. Request size is capped at 100 KB. |
| **Trustworthy audit field** | "Logged by" on a visit is taken from the signed-in session. The browser cannot set it. |
| **Encryption in transit (optional)** | HTTPS can be switched on by adding a certificate and key (see "HTTPS"). Without them the server runs as plain HTTP and prints a warning. |
| **Basic headers** | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `no-store` caching on API responses. |

**First run:** while there are no staff accounts, the first account can be
created without signing in (the app shows a "create manager account" form).
That first account is always a manager. Create it straight away after
starting the server for the first time. After that, only a manager can add
accounts.

### Roles

| Action | Floor staff | Manager |
|---|---|---|
| Search and view guests, upcoming occasions | Yes | Yes |
| Add guests, edit details and notes | Yes | Yes |
| Log visits and add occasions | Yes | Yes |
| Delete a guest (and all their records) | No | Yes |
| Data retention review screen | No (hidden) | Yes |
| Add, remove staff; change roles | No | Yes |
| Read the activity log | No | Yes |

Roles are enforced on the server, not just hidden in the app: a floor-staff
request to a manager-only action gets `403`. The server re-checks the role on
every request, so a promotion, demotion or removal takes effect immediately.
It will not let you remove yourself, remove the last manager, or demote the
last manager, so the system can't be locked out. 

### Browsing the guest list (less scrolling)

- The guest list is compact: one row per guest with name, phone, up to three
  tags (an allergy is never hidden) and the latest note on one line.
- The list shows **10 guests per page** with Previous / Next buttons at the top
  and bottom, instead of one very long page.
- The search and filter bar stays at the top while scrolling.
- The left menu stays in place. The manager tools (Manage staff, Manage tags,
  Notes -> tags, Activity log, Backups) are folded into one **Manager tools**
  button that opens and closes.
- On a guest profile, **Log visit** is at the top, and the visit history shows the
  latest 5 visits with a "Show all" button.

### Search suggestions

As staff type in the search box, a list of suggestions appears under it: matching
**guest names**, **phone numbers** (when digits are typed), **tags** (for example
"Peanut", "Vegan") and **words used in notes** with how many guests use them.
Tap a suggestion, or use the arrow keys and Enter, to fill the search box. Press
Esc to close the list. Suggestions are built in the browser from the guest list
already on screen, so nothing extra is stored or sent. Because they show real
names and numbers, they are visible only to signed-in staff.

### Days since last visit

Each guest card shows how many days it has been since their most recent logged
visit (e.g. "45d since last visit"), next to the "Birthday in…" badge. It turns
amber at 90 days or more. Guests with no logged visit show "No visits yet". The
profile page shows the same in words. It is worked out from the visit log, so
staff need to keep logging visits for it to be accurate.

### Guest tags (allergies, diet, seating)

Staff tap ready-made tags instead of typing notes, which avoids spelling
mistakes and makes allergies searchable. Tags are chosen when adding or editing
a guest (floor staff and managers can both do this), appear as coloured chips on
the guest card, and show as a red "Allergies:" line at the top of the profile.
The **Any tag** filter and the search box both find guests by tag (for example
"vegan" or "peanut"). The free-text note is still there for anything unusual.

**Existing guests:** guests added before tags existed have their allergies and diets
typed into the notes, so the tag filter will not find them. A manager can open
**Notes → tags** in the left menu: it previews what it found (for example
"Allergic to peanuts" → Peanut), then **Add these tags** saves them. Allergy
tags are only suggested when the note mentions an allergy or intolerance
("Nut allergy" adds both Peanut and Tree nut, to be safe). Notes are never
changed, only missing tags are added, and the action is written to the activity
log. Spot-check a few guests afterwards, because it matches keywords and cannot
read context perfectly.

**Adding your own tags:** a manager opens **Manage tags** in the left menu, picks a
group (Allergies, Diet or Seating and service), types a name and taps **Add tag**.
It appears straight away on every tablet. Custom tags can be renamed or removed
(removing asks for confirmation and takes the tag off the guests who have it).
Built-in tags cannot be changed. Floor staff can use tags but not edit the list,
duplicate names are refused, and each change is written to the activity log.
Developers can still change the built-in list in `TAG_GROUPS` in `server.js`. Existing guests keep their old notes, and no tags are added to
them automatically. Unknown tags are rejected by the server.

**Privacy:** allergy and dietary tags (especially medical allergies and
religious diets such as halal or kosher) can be sensitive information under the
Australian Privacy Principles. Only staff who need it to serve guests safely
should have access, and the tags are deleted with the guest record.

### Activity log (audit trail)

Sign-ins, lockouts after too many wrong PINs, guest deletions, staff
additions and removals, and role changes are saved in the database
(`audit_log` table) as well as printed in the server window as `[audit]`
lines. They survive a server restart. Managers can read the latest 200 entries
under **Activity log** in the left menu; floor staff cannot see it. Entries
record who did what and when, but never guest names or phone numbers (a
deleted guest is recorded by ID only), so deleting a guest really removes their
details. Entries are never edited by the app.

**Automatic trimming.** Once a day (and when the server starts), entries older
than 365 days are removed from the database so the log does not grow forever.
Before they are removed they are appended to `audit-archive.csv` in the backups
folder, and the trim itself is recorded in the log ("Activity log trimmed: N
entries ... moved to audit-archive.csv"). Set `AUDIT_KEEP_DAYS` (minimum 30) to
keep a different number of days. Managers can press **Download CSV** in the
Activity log screen to save the whole current log. The archive file contains
staff names and actions, so keep it private like the backups (it is excluded
from GitHub).

**Housekeeping:** delete `guests.csv` from the project folder once the import
is done, because it holds real customer data.

## Starting automatically (Windows)

On a real deployment the server computer will be switched off and on, and nobody
should have to open a terminal and type `npm start`. These scripts register the
server with Windows Task Scheduler so it **starts when the computer starts, before
anyone signs in**, and is **restarted every minute if it stops**. Nothing extra is
installed.

**Set it up (once).**

1. Install Node.js **for all users** (the normal installer from nodejs.org does
   this) and run `npm install` in the project folder.
2. Close any window that is already running the server.
3. Open PowerShell **as administrator** (right-click, Run as administrator), go to
   the project folder, and run:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -OpenFirewall -NoSleep
   ```

   `-OpenFirewall` lets tablets on a private Wi-Fi network reach the server, and
   `-NoSleep` stops the computer sleeping while plugged in. Both are optional;
   leave them out to do those steps yourself. Use `-Port 8080` for a different port.
4. Restart the computer once, wait a minute, and open the address from a tablet.
   If the guest list loads, it works.

**Day to day.** The server's output (including the activity messages) is saved in
`logs\server.log`. If something is wrong, look at the end of that file first.
In PowerShell (as administrator):

| To do this | Run |
|---|---|
| See whether it is running | `Get-ScheduledTask GuestBookServer` |
| Stop it | `Stop-ScheduledTask GuestBookServer` |
| Start it | `Start-ScheduledTask GuestBookServer` |
| Remove auto-start | `powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1` |

**After changing the code** (for example a new `server.js`), stop and start the
task so it picks up the change. **Do not also run `npm start`** in a window while
the task is running: both would try to use the same port.

**Good to know.**

- The task runs as the Windows SYSTEM account, so files it creates (the log, new
  backups) may need administrator rights to delete. Your data and backups are not
  moved or changed.
- `logs\server.log` keeps growing. Delete or archive it now and then (stop the
  task first).
- If the server cannot start (for example the port is already in use), Windows
  keeps retrying every minute, and the reason is written to `logs\server.log`.
- Sessions are held in memory, so a restart signs everyone out. Staff sign in again.
- On a Mac or Linux server use the system's own service manager (launchd or
  systemd), or PM2 (`npm i -g pm2`, `pm2 start server.js`, `pm2 startup`).

## Backups and restore

The server saves a complete backup of the database **automatically every 24 hours**
(it checks when it starts and then once an hour) into the `backups` folder next to
`server.js`. It keeps the newest 14 copies and deletes older ones. Backups are made
with SQLite's own `VACUUM INTO`, so they are consistent even while staff are using
the app. Each backup is opened and checked before it is trusted.

**What a backup contains.** All guest records, visit history, tags, staff accounts
(PIN hashes only) and the activity log. That is personal information, so the
`backups` folder is excluded from GitHub (`.gitignore`) and must be kept private.

**Settings (optional environment variables).**

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | `backups` in the project folder | Where backups are saved. Point it at a second drive or a synced folder. |
| `BACKUP_KEEP` | `14` | How many of the newest backups to keep. |
| `AUDIT_KEEP_DAYS` | `365` | Days of activity log kept in the database before older entries are archived to CSV (minimum 30). |

**In the app (managers only).** Press **Backups** in the sidebar to see the list,
press **Back up now** for an extra copy before a risky change, or **Download** to
save a copy to the computer you are using. Each manual backup and download is
written to the activity log.

**A backup on the same computer is not enough.** If that computer fails, the
backups go with it. At least once a week, copy the newest file in `backups` to a
USB drive or a private cloud folder (or set `BACKUP_DIR` to one).

**Restoring.**

1. Stop the server (close its window or press Ctrl+C).
2. Run `node scripts/restore-backup.js backups/<file>.db`
   (for example `backups/guestbook-2026-11-16-020000.db`).
3. Start the server again with `node server.js`.

The script checks the file is a real Guest Book backup, keeps the current database
as `guestbook.before-restore-<time>.db` (so a restore can be undone) and prints the
guest and staff counts it restored. Practise a restore once, on a copy, before you
need it.

## HTTPS (encrypting the connection)

Without HTTPS, PINs, sign-in tokens and guest data travel over the Wi-Fi as
plain text. The server supports HTTPS: put a certificate and key in a `certs`
folder as `certs/cert.pem` and `certs/key.pem` (or point the `TLS_CERT` and
`TLS_KEY` environment variables at them) and start the server as normal. The
start-up message then says **HTTPS** and prints `https://` addresses. If only
one of the two files is present, or a path is wrong, the server stops with a
clear message instead of quietly running unencrypted. With no files it runs as
plain HTTP and prints a warning.

The tablets must also trust the certificate, or the browser shows a "not
secure" warning. Choose one option:

### Option 1: Local certificate with mkcert (best for a demo)

1. Install mkcert on the server computer. Windows: `winget install FiloSottile.mkcert`
   (or `choco install mkcert`). Mac: `brew install mkcert`.
2. Run `mkcert -install` once. This creates a private certificate authority and
   makes this computer trust it.
3. Find the server's address (`ipconfig` on Windows) and give the server a fixed
   address, for example a DHCP reservation in the router. The certificate is tied
   to this address, so it stops working if the address changes.
4. In the project folder run:
   `mkdir certs`
   `mkcert -cert-file certs/cert.pem -key-file certs/key.pem 192.168.1.42 localhost`
   (use your own address instead of 192.168.1.42).
5. Run `npm start`. It should say HTTPS. Open `https://192.168.1.42:3000` on the
   server computer. There should be no warning.
6. Make each tablet trust the certificate authority. Run `mkcert -CAROOT` to see
   the folder and copy **only `rootCA.pem`** to the tablet (never `rootCA-key.pem`).
   - iPad/iPhone: open the file, allow the profile, then Settings > General >
     VPN & Device Management > install it. Then Settings > General > About >
     Certificate Trust Settings > switch on full trust for the mkcert certificate.
   - Android: Settings > Security > Encryption & credentials > Install a
     certificate > CA certificate, then choose the file (rename it to
     `rootCA.crt` if needed). Menu names vary by phone.
   - Windows laptop: double-click `rootCA.pem` > Install Certificate > Trusted
     Root Certification Authorities. (Firefox keeps its own list and needs the
     file imported in its settings.)
7. On each tablet open `https://192.168.1.42:3000`. You should see a padlock.

Keep `rootCA-key.pem` private: anyone with it could create certificates that
those tablets would trust. After a demo, remove the certificate from borrowed
devices.

### Option 2: Real certificate with a domain name (best for a real rollout)

Tablets trust this with nothing installed on them.

1. Buy a domain name (a few dollars to about $20 a year) and manage its DNS
   somewhere that supports an API or TXT records (Cloudflare is free).
2. Add a DNS **A record**, for example `guestbook.yourdomain.com`, that points to
   the server's private address (for example `192.168.1.42`). Give the server a
   fixed address. Some routers block public names that point to private
   addresses ("DNS rebind protection"). If the name does not resolve on the
   tablets, allow the domain in the router or add a local DNS entry.
3. Get a free Let's Encrypt certificate using the **DNS challenge** (this proves
   you own the domain without opening the server to the internet):
   - Windows: use win-acme (`wacs.exe`) with the DNS validation option.
   - Mac/Linux: use certbot (`certbot certonly --manual --preferred-challenges dns -d guestbook.yourdomain.com`)
     and add the TXT record it asks for, or use acme.sh with your DNS provider's
     API to renew automatically.
4. Copy the certificate chain (`fullchain.pem`) to `certs/cert.pem` and the
   private key (`privkey.pem`) to `certs/key.pem`.
5. Run `npm start` and open `https://guestbook.yourdomain.com:3000` on the
   tablets.
6. Certificates last about 90 days. Renew, copy the new files over and restart
   the server. Automated renewal (acme.sh or win-acme's scheduled task) avoids
   forgetting.

### Option 3: A hosted service (not recommended for this project)

A cloud host gives HTTPS automatically, but guest data would then leave the
restaurant, which needs a new privacy review. The database path is also fixed to
the project folder, so a host would need a small code change and a persistent
disk for `guestbook.db`. Treat this as a future option for a multi-venue business.

### If something goes wrong

- `NET::ERR_CERT_AUTHORITY_INVALID` or "not secure": this tablet does not trust
  the certificate authority yet (Option 1 step 6).
- `ERR_CERT_COMMON_NAME_INVALID`: the address in the browser does not match the
  certificate, for example the server's address changed. Create the certificate
  again for the new address.
- "This site can't be reached" after typing `http://`: the server now speaks
  HTTPS only, so type `https://`.
- Server prints "HTTPS setup is incomplete": both `certs/cert.pem` and
  `certs/key.pem` must exist, or both environment variables must be set.
- Never commit certificates or keys to GitHub. `.gitignore` already excludes the
  `certs` folder and all `.pem` files.

## Data privacy (OAIC / Australian Privacy Principles)

Two changes were made specifically to align this system with the Australian
Privacy Principles (APP 11 — security of personal information):

- **Staff PINs are hashed** (using Node's built-in `scrypt`, salted per
  account) rather than stored as plain text, and PIN verification happens
  entirely server-side — the browser never receives PINs or hashes.
- **Data retention review** — a "Data retention" tab in the app surfaces
  any guest with no recorded activity in the last 2 years, so staff can
  review and remove records that are no longer needed, rather than
  keeping guest data indefinitely.

These two changes don't make the system fully compliant on their own —
you should still have a plain-language privacy notice for customers (APP 1
and APP 5) and a documented data breach response process. See the OAIC's
Australian Privacy Principles guidelines for the full requirements.

## Known limitations to mention in your write-up

- HTTPS is supported but optional. Until a certificate is installed (see
  "HTTPS"), PINs, session tokens and guest data cross the Wi-Fi unencrypted.
  Fine only on a trusted, password-protected staff Wi-Fi.
- Old free-text notes are not converted to tags automatically; a manager uses
  Notes → tags once. Built-in tags are fixed (only custom tags can be edited).
- Sessions and lockout counters are held in memory, so a server restart
  signs everyone out and resets lockouts.
- Roles are a simple two-level split (manager / floor staff). The activity
  log records sign-ins, deletions and staff changes, but not every time a guest
  record is viewed or edited, and it is not protected against someone with direct access to the database file.
- There's a single server instance. Backups are automatic (daily) but are saved
  on the same computer unless `BACKUP_DIR` points elsewhere, and copying them
  off the machine is a manual step. A real deployment would want an
  off-site copy and a plan for what happens if the server machine goes down
  mid-service.
- No offline mode: if the server or Wi-Fi drops, tablets briefly can't
  read or write guest data until it's back.
- The "Data retention" review is manual (staff choose what to remove) —
  a production system might automate flagging or archiving on a schedule.
