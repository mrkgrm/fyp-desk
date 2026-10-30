-- Desk tables. Text and numbers only. Video files stay in Drive.

create table if not exists public.earnings (
  username text not null,
  name text not null default '',
  day date not null,
  net numeric not null default 0,
  gross numeric not null default 0,
  subs_net numeric not null default 0,
  tips_net numeric not null default 0,
  content_net numeric not null default 0,
  views integer not null default 0,
  timeline_views integer not null default 0,
  unique_viewers integer not null default 0,
  watch_minutes integer not null default 0,
  profile_visits integer not null default 0,
  followers integer,
  subscribers integer,
  updated_at timestamptz not null default now(),
  primary key (username, day)
);

create table if not exists public.posts (
  id text primary key,
  source text not null default 'airtable',
  username text not null default '',
  name text not null default '',
  posted_at timestamptz,
  day date,
  status text not null default '',
  caption text not null default '',
  notes text not null default '',
  poster text not null default '',
  method text not null default '',
  post_type text not null default '',
  url text not null default '',
  autonumber text not null default '',
  views integer,
  likes integer,
  updated_at timestamptz not null default now()
);

create table if not exists public.post_metrics (
  id text primary key,
  username text not null default '',
  name text not null default '',
  day date,
  airtable_id text,
  views integer,
  preview_views integer,
  likes integer,
  interaction_time integer,
  preview_interaction_time integer,
  ai_note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.audience (
  username text not null,
  name text not null default '',
  day date not null,
  slot smallint not null,
  subscribers integer,
  followers integer,
  new_subscribers integer not null default 0,
  new_followers integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (username, day, slot)
);

create table if not exists public.errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  level text not null default 'error',
  account text not null default '',
  message text not null default '',
  unique (at, account, message)
);

alter table public.earnings enable row level security;
alter table public.posts enable row level security;
alter table public.post_metrics enable row level security;
alter table public.audience enable row level security;
create index if not exists post_metrics_day_idx on public.post_metrics (day);
alter table public.errors enable row level security;

create index if not exists earnings_day_idx on public.earnings (day);
create index if not exists posts_day_idx on public.posts (day);
create index if not exists posts_likes_idx on public.posts (likes desc);

-- One row per Fansly post. Views are For You stats for the insight window, null when Fansly did not list the clip.
-- engagement is average seconds watched: interaction time divided by For You views.
create table if not exists public.fyp_posts (
  post_id text primary key,
  creator text not null default '',
  fansly_username text not null default '',
  caption text not null default '',
  url text not null default '',
  media_likes integer,
  post_likes integer,
  posted_at timestamptz,
  last_metric_synced timestamptz,
  views integer,
  hashtag_count integer,
  length_seconds numeric,
  engagement numeric,
  comments integer,
  locked boolean,
  price numeric,
  sold integer,
  airtable_id text,
  status text not null default '',
  poster text not null default '',
  notes text not null default '',
  method text not null default '',
  hashtags text[] not null default '{}',
  interaction_time_ms bigint,
  preview_views integer,
  updated_at timestamptz not null default now()
);

alter table public.fyp_posts add column if not exists airtable_id text;
alter table public.fyp_posts add column if not exists status text not null default '';
alter table public.fyp_posts add column if not exists poster text not null default '';
alter table public.fyp_posts add column if not exists notes text not null default '';
alter table public.fyp_posts add column if not exists method text not null default '';
alter table public.fyp_posts add column if not exists hashtags text[] not null default '{}';
alter table public.fyp_posts add column if not exists interaction_time_ms bigint;
alter table public.fyp_posts add column if not exists preview_views integer;

alter table public.fyp_posts enable row level security;
create index if not exists fyp_posts_posted_at_idx on public.fyp_posts (posted_at desc);
create index if not exists fyp_posts_username_idx on public.fyp_posts (fansly_username);
create index if not exists fyp_posts_airtable_idx on public.fyp_posts (airtable_id);

-- One row per sync. Fansly view counts are a window, so a later pull must not erase the earlier one.
create table if not exists public.fyp_post_snapshots (
  post_id text not null references public.fyp_posts (post_id) on delete cascade,
  synced_on date not null,
  insight_range text not null,
  views integer,
  media_likes integer,
  post_likes integer,
  interaction_time_ms bigint,
  preview_views integer,
  avg_watch_seconds numeric,
  updated_at timestamptz not null default now(),
  primary key (post_id, synced_on, insight_range)
);

alter table public.fyp_post_snapshots enable row level security;
create index if not exists fyp_post_snapshots_synced_idx on public.fyp_post_snapshots (synced_on desc);

-- One month of rows, keyed by month (YYYY-MM). Philippine dates.
-- Shift 1 is 00:00–08:00, shift 2 is 08:00–16:00, shift 3 is 16:00–24:00.
-- earnings is the money that came in. refund is noted beside it, never as a negative earning.
-- locked is set once the day is seven days old. Locked rows are not edited again.

drop table if exists public.earnings_marks;
drop table if exists public.shift_earnings;
drop table if exists public.model_day_earnings;
drop table if exists public.agency_earnings;

create table if not exists public.month_shifts (
  month text not null,
  username text not null,
  name text not null default '',
  day date not null,
  shift smallint not null,
  earnings numeric not null default 0,
  refund numeric not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (username, day, shift)
);

create table if not exists public.month_daily (
  month text not null,
  username text not null,
  name text not null default '',
  day date not null,
  earnings numeric not null default 0,
  refund numeric not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (username, day)
);

create table if not exists public.day_refunds (
  month text not null,
  username text not null,
  name text not null default '',
  day date not null,
  refund numeric not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (username, day)
);

create table if not exists public.agency_shifts (
  month text not null,
  day date not null,
  shift smallint not null,
  earnings numeric not null default 0,
  refund numeric not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (day, shift)
);

create table if not exists public.agency_days (
  month text not null,
  day date not null,
  earnings numeric not null default 0,
  refund numeric not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (day)
);

alter table public.month_shifts enable row level security;
alter table public.month_daily enable row level security;
alter table public.day_refunds enable row level security;
alter table public.agency_shifts enable row level security;
alter table public.agency_days enable row level security;
create index if not exists month_shifts_month_idx on public.month_shifts (month, day);
create index if not exists month_daily_month_idx on public.month_daily (month, day);
create index if not exists agency_days_month_idx on public.agency_days (month, day);

-- New subscribers. A row counts when its subscription period starts (createdAt).
-- Shift 1 is 00:00–08:00, shift 2 is 08:00–16:00, shift 3 is 16:00–24:00, Philippine time.
-- locked is set once the day is seven days old.

create table if not exists public.sub_shifts (
  month text not null,
  username text not null,
  name text not null default '',
  day date not null,
  shift smallint not null,
  subs integer not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (username, day, shift)
);

create table if not exists public.sub_daily (
  month text not null,
  username text not null,
  name text not null default '',
  day date not null,
  subs integer not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (username, day)
);

create table if not exists public.agency_sub_shifts (
  month text not null,
  day date not null,
  shift smallint not null,
  subs integer not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (day, shift)
);

create table if not exists public.agency_sub_days (
  month text not null,
  day date not null,
  subs integer not null default 0,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (day)
);

alter table public.sub_shifts enable row level security;
alter table public.sub_daily enable row level security;
alter table public.agency_sub_shifts enable row level security;
alter table public.agency_sub_days enable row level security;
create index if not exists sub_shifts_month_idx on public.sub_shifts (month, day);
create index if not exists sub_daily_month_idx on public.sub_daily (month, day);
create index if not exists agency_sub_days_month_idx on public.agency_sub_days (month, day);

create table if not exists public.report_sends (
  id text primary key,
  status text not null,
  updated_at timestamptz not null default now()
);
alter table public.report_sends enable row level security;
