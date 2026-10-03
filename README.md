# FC Inspect

Cleaning quality inspections for FC Cleaning Company: a phone-first PWA for supervisors plus an admin back office.
Installed on an iPhone it behaves like a native app: bottom tabs (Home · Inspections · Actions · More), a guided
start flow, one-item-at-a-time inspections with large touch targets, and a desktop layout with a sidebar.

- **Quality checks** — walk a site's checklist, photos + notes per item, score 1–10; anything below 7 needs an urgent action plan (what, who, deadline)
- **Before & after** — paired before/after photos per item, from a checklist or starting empty and adding items as you go
- **Admin** — review, edit, approve or send back; track urgent actions; PDF reports with or without notes
- Every submitted inspection is emailed to the admins with the PDF attached (marked URGENT on low scores)
- Works offline: inspections can be started, completed and submitted with no signal — everything queues on the phone (IndexedDB) and syncs when the connection returns; screens already seen open offline too

Stack: Node + Express 5, Postgres, plain JS ES modules front end (no framework, no build step), pdfkit for reports, nodemailer for email.

Front end (`public/`): `ui.js` design system + components · `app.js` shell, router, More/Sync · `inspect.js` outbox + supervisor
workflow · `lists.js` Home/Inspections/Actions · `review.js` report + admin review · `admin.js` clients, templates, team.

## Run locally

```sh
npm install
cp .env.example .env            # set DATABASE_URL (+ storage and email settings if needed)
psql "$DATABASE_URL" -f db/schema.sql
node scripts/create-user.mjs you@example.com "Your Name" admin   # prints a password
npm start                       # http://localhost:4620
```

Photos are stored through a small HTTP storage service (`lib/home-storage.mjs`); point `HOME_STORAGE_*` at your own.

## Deploy (perchito)

One-off: `sudo bash setup-perchito.sh <admin-email> "<name>"` (database, `.env`, systemd unit, backups registration).
Updates: rsync the repo (without `.env`), `npm ci --omit=dev`, `sudo systemctl restart fc-inspect`.
