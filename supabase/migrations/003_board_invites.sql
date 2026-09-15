-- Pinboard — Phase 3: invite someone to a board by email
--
-- Membership needs an account, but the person you want to share a board with
-- may not have signed up yet. An invite holds their email against the board;
-- when an account with that email is created, the signup trigger turns the
-- invite into a membership.
--
-- Additive and safe to run on the live board. Contains no personal data —
-- the actual invites are created with a one-off query, not committed here,
-- because this repo is public.
--
-- Run in: https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

create table if not exists public.board_invites (
  board_id   uuid not null references public.boards(id) on delete cascade,
  email      text not null,
  role       text not null default 'member' check (role in ('owner','member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists board_invites_board_email_idx
  on public.board_invites (board_id, lower(email));

alter table public.board_invites enable row level security;

-- Owners can see and manage invites to their own boards; nobody else can
-- read them, since an invite list is a list of other people's addresses.
drop policy if exists "invites: owners manage" on public.board_invites;
create policy "invites: owners manage" on public.board_invites
  for all to authenticated
  using (public.is_board_owner(board_id))
  with check (public.is_board_owner(board_id));

-- ---------------------------------------------------------------------
-- Signup: personal board as before, plus any boards you were invited to
--
-- This fires when the account row is created, which for a magic link is
-- before the email has been confirmed. That is safe: the membership is
-- attached to the account for that address, and only whoever controls the
-- inbox can ever get a session for it.
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

  insert into public.board_members (board_id, user_id, role)
  select i.board_id, new.id, i.role
  from public.board_invites i
  where lower(i.email) = lower(new.email)
  on conflict (board_id, user_id) do nothing;

  delete from public.board_invites where lower(email) = lower(new.email);

  return new;
end;
$$;
