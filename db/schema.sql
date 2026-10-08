-- FC Inspect — Postgres schema. Self-hosted on perchito. Safe to re-run.

create extension if not exists pgcrypto;

create table if not exists clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,
  email        text,
  phone        text,
  created_at   timestamptz not null default now()
);

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  name       text not null,
  role       text not null check (role in ('admin', 'inspector', 'cleaner', 'client')),
  pass_hash  text not null,
  client_id  uuid references clients(id) on delete cascade,  -- set for role = client
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  check ((role = 'client') = (client_id is not null))
);
create unique index if not exists users_email_idx on users (lower(email));

create table if not exists sessions (
  token_hash text primary key,  -- sha256 of the cookie value
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists sites (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  name       text not null,
  address    text,
  created_at timestamptz not null default now()
);

create table if not exists site_cleaners (
  site_id uuid not null references sites(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (site_id, user_id)
);

create table if not exists templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  items      jsonb not null default '[]',  -- [{key, label, hint}]
  created_at timestamptz not null default now()
);

create table if not exists site_templates (
  site_id     uuid not null references sites(id) on delete cascade,
  template_id uuid not null references templates(id) on delete cascade,
  primary key (site_id, template_id)
);

create table if not exists inspections (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references sites(id),
  template_id      uuid references templates(id) on delete set null,
  template_name    text not null,
  inspector_id     uuid not null references users(id),
  status           text not null default 'draft'
                   check (status in ('draft', 'submitted', 'returned', 'approved')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  start_gps        jsonb,  -- {lat, lng, accuracy}
  end_gps          jsonb,
  inspector_sig    text,   -- PNG data URL
  approved_by      uuid references users(id),
  approved_at      timestamptz,
  emailed_at       timestamptz,
  emailed_to       text,
  client_signed_by uuid references users(id),
  client_sig       text,
  client_signed_at timestamptz
);
create index if not exists inspections_status_idx on inspections (status);
create index if not exists inspections_site_idx on inspections (site_id);

-- copy of the template items taken when the inspection starts, so later
-- template edits never change old reports
create table if not exists inspection_items (
  inspection_id uuid not null references inspections(id) on delete cascade,
  item_key      text not null,
  position      int  not null,
  label         text not null,
  note          text not null default '',
  primary key (inspection_id, item_key)
);
alter table inspection_items add column if not exists hint text not null default '';

create table if not exists photos (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  item_key      text not null,
  storage_key   text not null,
  caption       text not null default '',
  taken_at      timestamptz,
  gps           jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists photos_inspection_idx on photos (inspection_id);

create table if not exists comments (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  user_id       uuid not null references users(id),
  body          text not null,
  created_at    timestamptz not null default now()
);

-- before & after inspections (deep cleans): photos come in pairs, an "after" photo
-- points at the "before" photo it was taken to match
alter table inspections add column if not exists mode text not null default 'check';
do $$ begin
  alter table inspections add constraint inspections_mode_check check (mode in ('check', 'before_after'));
exception when duplicate_object then null; end $$;
alter table photos add column if not exists phase text check (phase in ('before', 'after'));
alter table photos add column if not exists pair_id uuid references photos(id) on delete set null;

-- who a comment is for: 'internal' = admin <-> inspector (send-back reasons),
-- 'client' = admin <-> client (portal replies). Cleaners see neither.
alter table comments add column if not exists audience text not null default 'internal';
do $$ begin
  alter table comments add constraint comments_audience_check check (audience in ('internal', 'client'));
exception when duplicate_object then null; end $$;

-- quality checks: every item scored 1-10; below 7 needs an urgent action plan
alter table inspection_items add column if not exists score smallint check (score between 1 and 10);
alter table inspection_items add column if not exists action_what text;
alter table inspection_items add column if not exists action_who text;
alter table inspection_items add column if not exists action_due date;
alter table inspection_items add column if not exists action_done_at timestamptz;
alter table inspection_items add column if not exists action_done_by uuid references users(id);

-- items the inspector added on site (not from the template)
alter table inspection_items add column if not exists added boolean not null default false;

-- items can be grouped under an area (template item {area: 'Kitchen'}), numbered 1.1, 1.2…
alter table inspection_items add column if not exists area text not null default '';

-- prospects: a client created by a quick inspection (no site picked); named later, then made a real client
alter table clients add column if not exists prospect boolean not null default false;

-- shared inspections: any supervisor can work on an open one. contributors = everyone other than the
-- starter who changed it; submitted_by = whoever signed and submitted
alter table inspections add column if not exists contributors uuid[] not null default '{}';
alter table inspections add column if not exists submitted_by uuid references users(id);

-- recently deleted: an admin's delete only hides the inspection; it is purged 30 days later (or sooner by hand)
alter table inspections add column if not exists deleted_at timestamptz;
alter table inspections add column if not exists deleted_by uuid references users(id);
