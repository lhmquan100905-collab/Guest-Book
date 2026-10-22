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

Roles are enforced on the server, not just hidden in the app: a floor-staff
request to a manager-only action gets `403`. The server re-checks the role on
every request, so a promotion, demotion or removal takes effect immediately.
It will not let you remove yourself, remove the last manager, or demote the
last manager, so the system can't be locked out. Guest deletions, staff
changes and role changes are written to the server window as `[audit]` lines
(who did what).

**Housekeeping:** delete `guests.csv` from the project folder once the import
is done, because it holds real customer data.

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

- There's no HTTPS (plain HTTP), so PINs, session tokens and guest data
  cross the Wi-Fi unencrypted. Fine only on a trusted, password-protected
  staff Wi-Fi; a real deployment should add HTTPS/TLS.
- Sessions and lockout counters are held in memory, so a server restart
  signs everyone out and resets lockouts.
- Roles are a simple two-level split (manager / floor staff). The `[audit]`
  lines only go to the server window; a production system would store a
  proper audit log of who viewed or changed what.
- There's a single server instance with no automatic backups — a real
  deployment would want scheduled database backups and a plan for what
  happens if the server machine goes down mid-service.
- No offline mode: if the server or Wi-Fi drops, tablets briefly can't
  read or write guest data until it's back.
- The "Data retention" review is manual (staff choose what to remove) —
  a production system might automate flagging or archiving on a schedule.
