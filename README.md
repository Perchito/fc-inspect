# FC Inspect

Cleaning quality inspections for FC Cleaning Company: a phone-first PWA for supervisors plus an admin back office.

- **Quality checks** — walk a site's checklist, photos + notes per item, score 1–10; anything below 7 needs an urgent action plan (what, who, deadline)
- **Before & after** — paired before/after photos per item, from a checklist or starting empty and adding items as you go
- **Admin** — review, edit, approve or send back; track urgent actions; PDF reports with or without notes
- Every submitted inspection is emailed to the admins with the PDF attached (marked URGENT on low scores)
- Works on a weak signal: photos, notes and submits queue on the phone and upload when the connection returns

Stack: Node + Express 5, Postgres, plain JS front end (no build step), pdfkit for reports, nodemailer for email.

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
