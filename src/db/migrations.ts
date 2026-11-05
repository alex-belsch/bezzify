// Jede Tabelle mit Shopbezug hängt an site_id und jede Site an einem Workspace (Mandant), so bleibt das Modell SaaS tauglich
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
create table if not exists workspaces (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  email text not null unique,
  name text,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'owner',
  primary key (workspace_id, user_id)
);

create table if not exists sites (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  platform text not null default 'custom',
  domains text[] not null default '{}',
  currency text not null default 'EUR',
  timezone text not null default 'Europe/Berlin',
  public_key text not null unique,
  secret_key_hash text not null,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  visitor_id text,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  channel text not null,
  source text,
  medium text,
  campaign text,
  content text,
  term text,
  is_paid boolean not null default false,
  click_id_type text,
  click_id text,
  ext_campaign_id text,
  ext_adset_id text,
  ext_ad_id text,
  landing_url text,
  referrer text,
  device text,
  ip_trunc text,
  pageviews int not null default 0,
  event_count int not null default 0,
  consent boolean not null default true
);
create index if not exists sessions_visitor_idx on sessions (site_id, visitor_id, last_seen_at desc);
create index if not exists sessions_started_idx on sessions (site_id, started_at);

create table if not exists events (
  site_id text not null references sites(id) on delete cascade,
  id text not null,
  session_id text,
  visitor_id text,
  name text not null,
  ts timestamptz not null,
  url text,
  props jsonb,
  primary key (site_id, id)
);
create index if not exists events_ts_idx on events (site_id, ts desc);

create table if not exists identities (
  site_id text not null references sites(id) on delete cascade,
  visitor_id text not null,
  kind text not null,
  value text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (site_id, visitor_id, kind, value)
);
create index if not exists identities_value_idx on identities (site_id, kind, value);

create table if not exists orders (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  external_id text not null,
  order_number text,
  created_at timestamptz not null,
  currency text not null default 'EUR',
  total numeric(14,2) not null default 0,
  tax numeric(14,2) not null default 0,
  shipping numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  refunded numeric(14,2) not null default 0,
  status text not null default 'paid',
  is_test boolean not null default false,
  customer_key text,
  email_sha256 text,
  phone_sha256 text,
  is_new_customer boolean,
  visitor_id text,
  checkout_token text,
  landing_url text,
  referrer text,
  items jsonb,
  match_data text,
  match_data_at timestamptz,
  consent_marketing boolean,
  source text not null,
  updated_at timestamptz not null default now(),
  unique (site_id, external_id)
);
create index if not exists orders_created_idx on orders (site_id, created_at);
create index if not exists orders_customer_idx on orders (site_id, customer_key);
create index if not exists orders_email_idx on orders (site_id, email_sha256);
create index if not exists orders_token_idx on orders (site_id, checkout_token);

create table if not exists refunds (
  site_id text not null references sites(id) on delete cascade,
  external_id text not null,
  order_external_id text not null,
  amount numeric(14,2) not null,
  created_at timestamptz not null,
  primary key (site_id, external_id)
);

create table if not exists costs (
  site_id text not null references sites(id) on delete cascade,
  date date not null,
  platform text not null,
  channel text not null,
  campaign_id text not null default '',
  campaign_name text,
  adset_id text not null default '',
  adset_name text,
  ad_id text not null default '',
  ad_name text,
  spend numeric(14,4) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  platform_conversions numeric(14,4),
  platform_revenue numeric(14,4),
  currency text,
  updated_at timestamptz not null default now(),
  primary key (site_id, date, platform, campaign_id, adset_id, ad_id)
);
create index if not exists costs_date_idx on costs (site_id, date);

create table if not exists manual_costs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  channel text not null,
  label text not null,
  amount numeric(14,2) not null,
  date_from date not null,
  date_to date not null,
  created_at timestamptz not null default now()
);

create table if not exists integrations (
  site_id text not null references sites(id) on delete cascade,
  platform text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  secrets text,
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (site_id, platform)
);

create table if not exists outbox (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  target text not null,
  order_id text not null,
  status text not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  response text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (site_id, target, order_id)
);
create index if not exists outbox_due_idx on outbox (status, next_attempt_at);
`,
  },
  {
    // verified: Verknüpfung stammt aus einer vom Shop gemeldeten Bestellung, nicht nur aus dem Browser
    id: '002_verified_identities_and_logout',
    sql: `
alter table identities add column if not exists verified boolean not null default false;
alter table users add column if not exists sessions_revoked_at timestamptz;
`,
  },
  {
    // ref ist order:<Bestell ID> (Server API) oder checkout:<Token> (Shopify Danke Seite, die Bestellung kann noch fehlen)
    id: '003_survey_answers',
    sql: `
create table if not exists survey_answers (
  site_id text not null references sites(id) on delete cascade,
  ref text not null,
  answer text not null,
  created_at timestamptz not null default now(),
  primary key (site_id, ref)
);
create index if not exists survey_answers_created_idx on survey_answers (created_at);
`,
  },
];
