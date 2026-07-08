-- ═══════════════════════════════════════════════════════════════════
--  PokéVault v26 — Supabase Schema
--  Run this in: Supabase Dashboard → SQL Editor → New Query
--
--  ⚠️  DESTRUCTIVE — drops all existing PokéVault tables first.
--      Run this once to get a clean slate for v26.
--
--  CHANGES vs v25:
--    • Schema version bumped to v26 (matches app release)
--    • No structural changes from v25 — graded chart data is fetched
--      live from the API, not stored. price_history_cache RLS tightened.
--    • profiles trigger added: auto-creates a profiles row on signup
--      so share settings always have a row to UPDATE (fixes the 400)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Drop all existing PokéVault tables (dependants first) ──────
drop table if exists public.trade_analyses      cascade;
drop table if exists public.price_history_cache cascade;
drop table if exists public.price_history       cascade;
drop table if exists public.portfolio_items     cascade;
drop table if exists public.profiles            cascade;

-- ── 2. Drop the auto-profile trigger if it exists from a prior run ─
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════════
--  TABLE: profiles
-- ═══════════════════════════════════════════════════════════════════
-- NOTE: Passwords are NEVER stored here. Supabase Auth handles
--       bcrypt hashing internally via auth.users. Do NOT add a
--       password or password_hash column to this table.
create table public.profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  username       text        not null unique,
  is_premium     boolean     not null default false,
  share_enabled  boolean     not null default false,
  share_slug     text        unique,         -- e.g. "ash-ketchum" → /p/ash-ketchum
  created_at     timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Authenticated users: own profile
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Public: anyone can look up a profile by slug (for sharing feature)
create policy "Public can view shared profiles"
  on public.profiles for select using (share_enabled = true);


-- ── Auto-create profiles row on signup ───────────────────────────
-- This is the key fix that makes saveShareSettings (.update()) work:
-- the profiles row is guaranteed to exist as soon as a user registers,
-- so the UPDATE never silently no-ops or falls back to an INSERT path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'username',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════════
--  TABLE: portfolio_items
-- ═══════════════════════════════════════════════════════════════════
create table public.portfolio_items (
  id                  uuid          primary key default gen_random_uuid(),
  user_id             uuid          not null references auth.users(id) on delete cascade,
  item_id             text          not null,
  type                text          not null check (type in ('card', 'sealed')),
  name                text          not null,
  set_name            text,
  image_url           text,
  language            text          not null default 'english',
  purchase_price      numeric(10,2) not null,
  quantity            integer       not null default 1 check (quantity > 0),
  condition_or_grade  text          not null default 'Near Mint',
  notes               text,
  current_value       numeric(10,2),
  last_value_updated  timestamptz,
  sold                boolean       not null default false,
  sold_price          numeric(10,2),
  sold_date           date,
  created_at          timestamptz   not null default now()
);

alter table public.portfolio_items enable row level security;

-- Authenticated users: own items
create policy "Users can select own portfolio items"
  on public.portfolio_items for select using (auth.uid() = user_id);
create policy "Users can insert own portfolio items"
  on public.portfolio_items for insert with check (auth.uid() = user_id);
create policy "Users can update own portfolio items"
  on public.portfolio_items for update using (auth.uid() = user_id);
create policy "Users can delete own portfolio items"
  on public.portfolio_items for delete using (auth.uid() = user_id);

-- Public: anyone can read items belonging to a user who has sharing enabled
create policy "Public can view shared portfolio items"
  on public.portfolio_items for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = portfolio_items.user_id
        and p.share_enabled = true
    )
  );

create index idx_portfolio_items_user_id on public.portfolio_items(user_id);
create index idx_portfolio_items_sold    on public.portfolio_items(user_id, sold);


-- ═══════════════════════════════════════════════════════════════════
--  TABLE: price_history
-- ═══════════════════════════════════════════════════════════════════
create table public.price_history (
  id                bigint        generated always as identity primary key,
  user_id           uuid          not null references auth.users(id) on delete cascade,
  portfolio_item_id uuid          not null references public.portfolio_items(id) on delete cascade,
  recorded_date     date          not null,
  value_sgd         numeric(10,2) not null,
  created_at        timestamptz   not null default now(),
  unique (portfolio_item_id, recorded_date)
);

alter table public.price_history enable row level security;

create policy "Users can select own price history"
  on public.price_history for select using (auth.uid() = user_id);
create policy "Users can insert own price history"
  on public.price_history for insert with check (auth.uid() = user_id);
create policy "Users can update own price history"
  on public.price_history for update using (auth.uid() = user_id);

create index idx_price_history_item_date
  on public.price_history(portfolio_item_id, recorded_date);


-- ═══════════════════════════════════════════════════════════════════
--  TABLE: price_history_cache
-- ═══════════════════════════════════════════════════════════════════
-- Stores raw USD prices from PokémonPriceTracker API.
-- Written only via service_role key (serverless functions).
-- No browser client ever touches this directly.
create table public.price_history_cache (
  id            bigint        generated always as identity primary key,
  item_id       text          not null,
  type          text          not null,
  price         numeric(10,4) not null,
  language      text          not null default 'english',
  recorded_date date          not null,
  created_at    timestamptz   not null default now(),
  unique (item_id, type, language, recorded_date)
);

alter table public.price_history_cache enable row level security;

-- price_history_cache is written only by server-side functions (service_role key).
-- No authenticated or anonymous browser user needs to read it directly.
-- RLS is enabled; no permissive SELECT policy is created here,
-- so only service_role (which bypasses RLS) can access this table.
-- If you ever need to expose cached prices to the client, add a SELECT policy here.

create index idx_phc_item_date
  on public.price_history_cache(item_id, recorded_date);


-- ═══════════════════════════════════════════════════════════════════
--  TABLE: trade_analyses
-- ═══════════════════════════════════════════════════════════════════
create table public.trade_analyses (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references auth.users(id) on delete cascade,
  my_items        jsonb         not null default '[]',
  their_items     jsonb         not null default '[]',
  my_total_sgd    numeric(10,2) not null,
  their_total_sgd numeric(10,2) not null,
  cash_direction  text,
  cash_amount_sgd numeric(10,2),
  diff_pct        numeric(6,2)  not null,
  verdict         text          not null,
  created_at      timestamptz   not null default now()
);

alter table public.trade_analyses enable row level security;

create policy "Users can select own trade analyses"
  on public.trade_analyses for select using (auth.uid() = user_id);
create policy "Users can insert own trade analyses"
  on public.trade_analyses for insert with check (auth.uid() = user_id);
create policy "Users can delete own trade analyses"
  on public.trade_analyses for delete using (auth.uid() = user_id);

create index idx_trade_analyses_user_id
  on public.trade_analyses(user_id, created_at desc);


-- ═══════════════════════════════════════════════════════════════════
--  DONE
--  After running this script:
--    1. Deploy pokevault-v26 to Vercel (git push → auto-deploy)
--    2. Verify env vars in Vercel dashboard:
--         SUPABASE_URL          — your Supabase project URL
--         SUPABASE_ANON_KEY     — anon/public key
--         SUPABASE_SERVICE_KEY  — service_role key (server-side only)
--         POKEPRICE_API_KEY     — PokémonPriceTracker bearer token
--    3. New users will get a profiles row automatically via the
--       on_auth_user_created trigger — share settings will just work.
-- ═══════════════════════════════════════════════════════════════════
