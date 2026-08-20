-- Command Deck — tasks table
-- Run this once in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

create table if not exists public.tasks (
  id         text primary key,
  title      text not null,
  area       text not null,
  status     text not null,
  notes      text not null default '',
  parent_id  text references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safe to re-run against a table created before sub-tasks existed.
alter table public.tasks add column if not exists parent_id text references public.tasks(id) on delete cascade;
create index if not exists tasks_parent_id_idx on public.tasks(parent_id);

-- Cap hierarchy at two levels: a sub-task's parent must itself be a
-- top-level task, never another sub-task.
create or replace function public.check_task_depth()
returns trigger as $$
begin
  if new.parent_id is not null then
    if exists (select 1 from public.tasks where id = new.parent_id and parent_id is not null) then
      raise exception 'Sub-tasks cannot themselves have sub-tasks (max 2 levels)';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_check_depth on public.tasks;
create trigger tasks_check_depth
  before insert or update on public.tasks
  for each row
  execute function public.check_task_depth();

-- Keep updated_at current on every UPDATE, even if a client forgets to set it.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row
  execute function public.set_updated_at();

-- RLS: this app has no real user accounts — it authenticates with the public
-- anon key only, gated by a client-side passcode screen (cosmetic, not
-- enforced by the database). Anyone holding the anon key can read/write this
-- table, so these policies intentionally grant the anon role full access.
-- Do not put sensitive data in this table.
alter table public.tasks enable row level security;

drop policy if exists "anon full access" on public.tasks;
create policy "anon full access" on public.tasks
  for all
  to anon
  using (true)
  with check (true);

-- Enable realtime change events for this table (safe to re-run).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
