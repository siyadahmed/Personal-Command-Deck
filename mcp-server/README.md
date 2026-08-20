# Kanban Board MCP Server

A small remote MCP server that lets Claude (Claude.ai, Cowork, Claude Desktop, Claude Code)
manage tasks on the Command Deck board directly — add tasks, add sub-tasks, move
things between columns, and list what's there.

It's purpose-built for this board only: five tools (`list_tasks`, `add_task`,
`add_subtask`, `update_task`, `delete_task`) that mirror exactly what the web UI
does, instead of exposing a general-purpose Supabase/SQL connector with much
broader access. It talks to the same `tasks` table as `index.html`, using the
same public anon key (already embedded in that page), so it respects the same
permissions and shows up live in the board via the existing realtime sync.

## Auth

The server requires a bearer token on every request — set as the `MCP_TOKEN`
secret. This is separate from (and more meaningful than) the board's cosmetic
passcode gate: this token is the only thing standing between anyone who finds
this server's URL and your task data, so keep it secret.

## First-time setup

```bash
cd mcp-server
npm install
npx wrangler login          # authorizes the CLI against your Cloudflare account
npx wrangler secret put MCP_TOKEN   # paste a long random token when prompted
npx wrangler deploy
```

`wrangler deploy` prints the live URL, something like:

```
https://kanban-mcp.<your-subdomain>.workers.dev
```

The MCP endpoint is that URL plus `/mcp`.

## Local testing

Copy `.dev.vars.example` to `.dev.vars` and fill in a test `MCP_TOKEN`, then:

```bash
npx wrangler dev
```

This serves the same code at `http://localhost:8787/mcp` for testing with curl
or the [MCP inspector](https://modelcontextprotocol.io/legacy/tools/inspector)
before deploying.

## Connecting it to Claude.ai / Cowork

1. In Claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Name: `Kanban Board` (or anything you like).
3. URL: `https://kanban-mcp.<your-subdomain>.workers.dev/mcp`
4. Authentication: choose the API key / bearer token option if offered, and
   enter it as header `Authorization` with value `Bearer <your MCP_TOKEN>`.
   (This is currently a beta feature on Claude's side — if your account's
   "Add custom connector" screen only offers OAuth client ID/secret fields
   and no plain header option, the token approach isn't available yet; ask
   for the fallback instead of guessing.)
5. Save and try asking Claude to list or add a task.

## Changing the tools

Tools are registered in `src/index.ts` inside `createServer()`. Each one is a
`server.registerTool(name, { title, description, inputSchema }, handler)`
call — the `zod` schema doubles as the tool's parameter validation and the
description the calling model sees. Area and status values are validated
against the same fixed lists (`AREAS`, `STATUSES`) as `index.html`, so a
mismatch here would mean the two are out of sync — update both together if
you ever add a new area or column.
