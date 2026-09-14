-- Pinboard — Phase 2: CUTOVER (breaking — read before running)
--
-- This is the step that makes access real. It revokes the public anon
-- read/write on tasks and replaces it with per-board membership.
--
-- DO NOT RUN until all three of these are true:
--   1. 001_boards_additive.sql has run.
--   2. You have signed in to the app at least once via magic link, so an
--      auth.users row (and your auto-created board) exists.
--   3. The app deployed to GitHub Pages has magic-link auth in it.
--      The moment this runs, the old anon-key build stops being able to
--      read anything and will show an empty board.
--
-- The MCP server also breaks here until it is moved off the anon key —
-- it will see zero rows. Update and redeploy it alongside this.
--
-- A backup of the pre-migration tasks is in ../../backups/.

-- ---------------------------------------------------------------------
-- 1. Adopt every existing task into your personal board
--
-- Looks the user up by email so there is no uuid to copy by hand, and
-- reuses the board the signup trigger already created rather than making
-- a second one. Aborts loudly rather than half-migrating.
-- ---------------------------------------------------------------------

do $$
declare
  v_email  text := 'you@example.com';  -- the account that owns the existing 128 tasks
  v_user   uuid;
  v_board  uuid;
  v_moved  bigint;
  v_orphan bigint;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'No auth.users row for %. Sign in via magic link first, then re-run.', v_email;
  end if;

  select b.id into v_board
  from public.boards b
  join public.board_members m on m.board_id = b.id
  where m.user_id = v_user and m.role = 'owner'
  order by b.created_at
  limit 1;

  if v_board is null then
    insert into public.boards (name, created_by) values ('My Board', v_user) returning id into v_board;
    insert into public.board_members (board_id, user_id, role) values (v_board, v_user, 'owner');
  end if;

  update public.tasks set board_id = v_board where board_id is null;
  get diagnostics v_moved = row_count;

  select count(*) into v_orphan from public.tasks where board_id is null;
  if v_orphan > 0 then
    raise exception 'Still % tasks with no board — aborting before anything is locked down.', v_orphan;
  end if;

  raise notice 'Adopted % tasks into board % for %', v_moved, v_board, v_email;
end $$;

-- Every task now has a home, so make that structural.
alter table public.tasks alter column board_id set not null;

-- ---------------------------------------------------------------------
-- 2. Replace public access with membership
--
-- This is the line that ends the "anon key in page source can read and
-- wipe everything" situation.
-- ---------------------------------------------------------------------

drop policy if exists "anon full access" on public.tasks;

drop policy if exists "tasks: board members" on public.tasks;
create policy "tasks: board members" on public.tasks
  for all to authenticated
  using (public.is_board_member(board_id))
  with check (public.is_board_member(board_id));

-- ---------------------------------------------------------------------
-- 3. Verify (expect: anon_policies = 0, orphan_tasks = 0)
-- ---------------------------------------------------------------------

select
  (select count(*) from pg_policies
     where schemaname='public' and tablename='tasks' and 'anon' = any(roles)) as anon_policies,
  (select count(*) from public.tasks where board_id is null)                  as orphan_tasks,
  (select count(*) from public.tasks)                                         as total_tasks,
  (select count(*) from public.boards)                                        as boards,
  (select count(*) from public.board_members)                                 as memberships;
