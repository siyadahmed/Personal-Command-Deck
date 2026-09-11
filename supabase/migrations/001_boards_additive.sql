-- Command Deck — Phase 1: boards + membership (ADDITIVE, non-breaking)
--
-- Safe to run on the live board. It only ADDS tables, columns and helpers.
-- The existing "anon full access" policy is deliberately left in place, so
-- the current site and MCP server keep working exactly as they do today.
--
-- The cutover that actually enforces per-user access is 002, and must not
-- run until the app has magic-link auth deployed. See that file's header.
--
-- Run in: https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

-- ---------------------------------------------------------------------
-- Boards and membership
-- ---------------------------------------------------------------------

create table if not exists public.boards (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.board_members (
  board_id  uuid not null references public.boards(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

-- RLS policies below filter by membership on every row, so this index is
-- what keeps the board from getting slower as tasks accumulate.
create index if not exists board_members_user_idx on public.board_members(user_id, board_id);

-- ---------------------------------------------------------------------
-- Membership check
--
-- SECURITY DEFINER matters here: a policy ON board_members that itself
-- queries board_members recurses infinitely. Running the lookup inside a
-- definer function bypasses RLS for that one query and breaks the cycle.
-- search_path is pinned so the function can't be hijacked via a shadowing
-- schema.
-- ---------------------------------------------------------------------

create or replace function public.is_board_member(b uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.board_members
    where board_id = b and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_board_owner(b uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.board_members
    where board_id = b and user_id = (select auth.uid()) and role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------
-- Tasks belong to a board, and remember who added them
--
-- Both nullable for now: existing rows have neither, and nothing may break
-- while the anon policy is still live. 002 backfills and tightens board_id.
-- created_by stays nullable — it's informational, and only meaningful on a
-- shared board where "who added this?" is a real question.
-- ---------------------------------------------------------------------

alter table public.tasks add column if not exists board_id   uuid references public.boards(id) on delete cascade;
alter table public.tasks add column if not exists created_by uuid references auth.users(id) on delete set null;

create index if not exists tasks_board_idx on public.tasks(board_id);

-- ---------------------------------------------------------------------
-- Every new account gets its own private board
--
-- Signups are open, so a stranger who finds the URL lands in an isolated
-- empty board of their own rather than a broken empty state. They cannot
-- see or join any other board — membership is only ever explicit.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_board uuid;
begin
  insert into public.boards (name, created_by)
  values ('My Board', new.id)
  returning id into new_board;

  insert into public.board_members (board_id, user_id, role)
  values (new_board, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- RLS on the new tables only. tasks keeps its existing anon policy until 002.
-- ---------------------------------------------------------------------

alter table public.boards        enable row level security;
alter table public.board_members enable row level security;

drop policy if exists "boards: read own"   on public.boards;
drop policy if exists "boards: create"     on public.boards;
drop policy if exists "boards: owner edit" on public.boards;

create policy "boards: read own" on public.boards
  for select to authenticated using (public.is_board_member(id));

create policy "boards: create" on public.boards
  for insert to authenticated with check (created_by = (select auth.uid()));

create policy "boards: owner edit" on public.boards
  for update to authenticated
  using (public.is_board_owner(id)) with check (public.is_board_owner(id));

drop policy if exists "members: read"   on public.board_members;
drop policy if exists "members: invite" on public.board_members;
drop policy if exists "members: remove" on public.board_members;

create policy "members: read" on public.board_members
  for select to authenticated using (public.is_board_member(board_id));

-- Only an owner adds people to a board — this is the sharing mechanism.
create policy "members: invite" on public.board_members
  for insert to authenticated with check (public.is_board_owner(board_id));

-- An owner can remove anyone; anyone can remove themselves.
create policy "members: remove" on public.board_members
  for delete to authenticated
  using (public.is_board_owner(board_id) or user_id = (select auth.uid()));
