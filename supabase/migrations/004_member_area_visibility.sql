-- Pinboard — Phase 4: owners choose which areas a member can see
--
-- A board owner sees everything. A member sees — and can add, edit, move or
-- delete — only tasks in the areas the owner has granted them. Hidden tasks
-- are filtered out by the database itself, so they never reach the member's
-- browser, not even as realtime events.
--
-- Requires 001–003. Safe to run on the live board: existing memberships are
-- all owners, who keep seeing everything. Contains no personal data.
--
-- NOTE for the MCP connector: it uses a secret key that bypasses these
-- policies, so it re-applies the same area rule in code (loadScope()).
--
-- Run in: https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

-- ---------------------------------------------------------------------
-- Which areas a member sees
--
-- NULL means every area, and only owners have NULL. A member must always
-- carry an explicit list — possibly empty — so a missing value can never
-- silently mean "sees everything".
-- ---------------------------------------------------------------------

alter table public.board_members add column if not exists visible_areas text[];
alter table public.board_invites add column if not exists visible_areas text[];

alter table public.board_members drop constraint if exists board_members_visible_areas_valid;
alter table public.board_members add constraint board_members_visible_areas_valid check (
  (role = 'owner'  and visible_areas is null) or
  (role = 'member' and visible_areas is not null
     and visible_areas <@ array['youtube','consulting','skill','hobby','invest','other']::text[])
);

alter table public.board_invites drop constraint if exists board_invites_visible_areas_valid;
alter table public.board_invites add constraint board_invites_visible_areas_valid check (
  (role = 'owner'  and visible_areas is null) or
  (role = 'member' and visible_areas is not null
     and visible_areas <@ array['youtube','consulting','skill','hobby','invest','other']::text[])
);

-- ---------------------------------------------------------------------
-- Task access: membership AND the task's area is visible to you
-- ---------------------------------------------------------------------

create or replace function public.can_see_area(b uuid, a text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.board_members
    where board_id = b
      and user_id = (select auth.uid())
      and (visible_areas is null or a = any(visible_areas))
  );
$$;

drop policy if exists "tasks: board members" on public.tasks;
drop policy if exists "tasks: visible areas" on public.tasks;

-- WITH CHECK uses the same rule, so a member can't create a task in a hidden
-- area, or move one into a hidden area.
create policy "tasks: visible areas" on public.tasks
  for all to authenticated
  using (public.can_see_area(board_id, area))
  with check (public.can_see_area(board_id, area));

-- Owners change what a member can see by updating their membership.
drop policy if exists "members: owner update" on public.board_members;
create policy "members: owner update" on public.board_members
  for update to authenticated
  using (public.is_board_owner(board_id))
  with check (public.is_board_owner(board_id));

-- ---------------------------------------------------------------------
-- Sub-tasks always share their parent's area
--
-- Area is now what decides visibility, so a family of tasks must be seen or
-- hidden together: a visible sub-task under a hidden parent, or a hidden one
-- skewing a visible parent's progress count, would both leak. Setting a
-- sub-task's area is ignored in favour of its parent's; changing a parent's
-- area carries its sub-tasks with it.
-- ---------------------------------------------------------------------

create or replace function public.sync_subtask_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    select p.area into new.area from public.tasks p where p.id = new.parent_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_sync_subtask_area on public.tasks;
create trigger tasks_sync_subtask_area
  before insert or update of area, parent_id on public.tasks
  for each row execute function public.sync_subtask_area();

create or replace function public.cascade_parent_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks set area = new.area
  where parent_id = new.id and area is distinct from new.area;
  return null;
end;
$$;

drop trigger if exists tasks_cascade_parent_area on public.tasks;
create trigger tasks_cascade_parent_area
  after update of area on public.tasks
  for each row
  when (new.parent_id is null and old.area is distinct from new.area)
  execute function public.cascade_parent_area();

-- Align any existing sub-task that disagrees with its parent (none at the time
-- of writing — this is for anyone replaying the migrations later).
update public.tasks c set area = p.area
from public.tasks p
where c.parent_id = p.id and c.area is distinct from p.area;

-- ---------------------------------------------------------------------
-- Invites carry their area grant into the membership
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

  insert into public.board_members (board_id, user_id, role, visible_areas)
  select i.board_id, new.id, i.role, i.visible_areas
  from public.board_invites i
  where lower(i.email) = lower(new.email)
  on conflict (board_id, user_id) do nothing;

  delete from public.board_invites where lower(email) = lower(new.email);

  return new;
end;
$$;

-- The signup trigger only helps people who don't have an account yet. This
-- lets someone who already has one accept pending invites; the app calls it
-- on every sign-in. It needs a session, so the email has been confirmed.
create or replace function public.claim_board_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select email into v_email from auth.users where id = (select auth.uid());
  if v_email is null then
    return 0;
  end if;

  insert into public.board_members (board_id, user_id, role, visible_areas)
  select i.board_id, (select auth.uid()), i.role, i.visible_areas
  from public.board_invites i
  where lower(i.email) = lower(v_email)
  on conflict (board_id, user_id) do nothing;
  get diagnostics v_count = row_count;

  delete from public.board_invites where lower(email) = lower(v_email);
  return v_count;
end;
$$;

revoke all on function public.claim_board_invites() from public, anon;
grant execute on function public.claim_board_invites() to authenticated;
