# Pinboard — setup runbook

Everything here is done in the Supabase dashboard or your Google account.
Direct links are for project `iurmlkqlasufztgtrzpf`.

All the auth settings live under the **Authentication** item in the left
sidebar — *not* under Project Settings, which is where they used to be.

| What | Link |
|---|---|
| SQL Editor | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new |
| SMTP | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/smtp |
| URL Configuration | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/url-configuration |
| Rate limits | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/rate-limits |
| Users | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/users |

---

## 1. Run the additive migration

Paste `supabase/migrations/001_boards_additive.sql` into the SQL Editor and
run it. This is safe on the live board: it only adds tables and columns, and
leaves the existing anon policy alone.

## 2. Gmail as the mail sender

First create a Google **App Password** — an ordinary account password will
not work, and the option only appears once 2-Step Verification is on:

Google Account → Security → 2-Step Verification → App passwords.
You get a 16-character code.

Then on the **SMTP** page above, enable custom SMTP:

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | your Gmail address |
| Password | the 16-character App Password |
| Sender email | the same Gmail address |
| Sender name | `Pinboard` |

Sender email has to be that same Gmail address. Gmail rewrites `From` to
whichever account authenticated, so anything else either fails or silently
sends as you anyway.

Then on the **Rate limits** page, raise the emails-per-hour cap. The default
is sized for Supabase's built-in test sender and is low enough to lock you
out of your own sign-ins while testing.

## 3. URL configuration

On the **URL Configuration** page:

- **Site URL**: `https://siyadahmed.github.io/Personal-Command-Deck/`
- **Redirect URLs**: add both of
  - `https://siyadahmed.github.io/Personal-Command-Deck/**`
  - `http://localhost:8744/index.html` (local testing)

A magic link whose redirect isn't on this list silently falls back to the
Site URL, which looks like the link "not working".

## 4. Sign in once

Open the site, enter your email, click the link in the inbox. This creates
your `auth.users` row, and the signup trigger from step 1 creates your board.

Confirm it worked on the **Users** page — you should see your email listed.

## 5. Run the cutover

Paste `supabase/migrations/002_boards_cutover.sql` and run it. It adopts
every existing task into your board and revokes public access.

It aborts with a clear error if step 4 hasn't happened, rather than
half-migrating.

Expected output: `anon_policies = 0`, `orphan_tasks = 0`, and your full task
count.

## 6. Your wife signs up

She opens the same URL and enters her own email. Signups are open, so she
gets an account and — via the trigger — her own empty board. She cannot see
yours; board membership is only ever explicit.

## 7. After cutover

The MCP server stops working at step 5, because it authenticates with the
anon key and will see zero rows. It needs moving to `service_role` with a
board-aware configuration. See `mcp-server/README.md`.
