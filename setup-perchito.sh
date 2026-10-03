#!/usr/bin/env bash
# One-off root setup for FC Inspect on perchito:
#   sudo bash ~/fc-inspect/setup-perchito.sh <admin-email> "<admin name>"
set -euo pipefail
ADMIN_EMAIL=${1:?admin email}; ADMIN_NAME=${2:?admin name}
cd /home/perchito/fc-inspect
DBPASS=$(openssl rand -hex 18)
STORAGE_KEY="hs_$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"

# database (same pattern as the panel's createProject)
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
create role p_fc_inspect login password '$DBPASS';
grant hs_projects to p_fc_inspect;
create database p_fc_inspect owner p_fc_inspect;
revoke all on database p_fc_inspect from public;
SQL
# register with the panel (storage api reads this per request): nightly + offsite backups pick up the db, storage holds photos
sudo -u perchito node -e '
const f="/etc/perchito/projects.json", fs=require("fs"), d=JSON.parse(fs.readFileSync(f));
d.projects["fc-inspect"]={name:"FC Inspect",createdAt:new Date().toISOString(),key:process.argv[2],publicRead:false,storage:true,db:{name:"p_fc_inspect",user:"p_fc_inspect",password:process.argv[1]}};
fs.writeFileSync(f,JSON.stringify(d,null,2))' "$DBPASS" "$STORAGE_KEY"

sed -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://p_fc_inspect:$DBPASS@127.0.0.1:5432/p_fc_inspect|" \
    -e "s|^HOME_STORAGE_KEY=.*|HOME_STORAGE_KEY=$STORAGE_KEY|" .env.example > .env
chown perchito:perchito .env && chmod 600 .env
sudo -u perchito bash -c 'set -a; . ./.env; psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f db/schema.sql'

cat > /etc/systemd/system/fc-inspect.service <<UNIT
[Unit]
Description=FC Inspect (cleaning quality inspections)
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service
[Service]
User=perchito
WorkingDirectory=/home/perchito/fc-inspect
EnvironmentFile=/home/perchito/fc-inspect/.env
ExecStart=/usr/bin/node /home/perchito/fc-inspect/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
# let perchito (deploys + the perchito control panel) manage this service without a password
for a in start stop restart enable disable; do echo "perchito ALL=(root) NOPASSWD: /usr/bin/systemctl $a fc-inspect, /usr/bin/systemctl $a fc-inspect.service"; done > /etc/sudoers.d/fc-inspect
chmod 440 /etc/sudoers.d/fc-inspect && visudo -cf /etc/sudoers.d/fc-inspect
systemctl daemon-reload
systemctl enable --now fc-inspect.service

echo
sudo -u perchito bash -c 'set -a; . ./.env; node scripts/create-user.mjs "$0" "$1" admin' "$ADMIN_EMAIL" "$ADMIN_NAME"
echo "Local: http://127.0.0.1:4620 — public hostname is added in the fccleaningcompany.com Cloudflare dashboard."
