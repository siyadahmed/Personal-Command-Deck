import {
	McpServer,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
	AuthorizationError,
	OAuthProvider,
	type AuthRequest,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

interface WorkerEnv {
	SUPABASE_URL: string;
	// Server-side secret key (sb_secret_…, or a legacy service_role JWT).
	// It bypasses row-level security, so the tools scope every query to the
	// configured user's boards themselves — see loadScope().
	SUPABASE_SECRET_KEY: string;
	// Whose boards this connector acts on. A secret rather than a var so the
	// address stays out of this public repo.
	MCP_USER_EMAIL: string;
	OWNER_PASSWORD: string;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
}

type AuthProps = { owner: true };

type FetchHandler = {
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response>;
};

const AREAS = ["youtube", "consulting", "skill", "hobby", "invest", "other"] as const;
const STATUSES = ["backlog", "todo", "progress", "blocked", "done"] as const;
const AREA_LABELS: Record<(typeof AREAS)[number], string> = {
	youtube: "YouTube",
	consulting: "Consulting",
	skill: "Skill Dev",
	hobby: "Hobby / Pi",
	invest: "Investing",
	other: "Other",
};

const areaSchema = z
	.enum(AREAS)
	.describe(
		`Area of life this task belongs to: ${AREAS.map((a) => `${a} (${AREA_LABELS[a]})`).join(", ")}.`,
	);
const statusSchema = z
	.enum(STATUSES)
	.describe(
		"Column on the board: backlog, todo (To Do), progress (In Progress), blocked, or done.",
	);

type Task = {
	id: string;
	title: string;
	area: string;
	status: string;
	notes: string;
	parent_id: string | null;
	board_id: string;
	created_by: string | null;
	created_at: string;
	updated_at: string;
};

type Board = { id: string; name: string; role: "owner" | "member"; created_at: string };

/** Who this connector acts as, and every board they may touch. */
type Scope = { userId: string; boards: Board[] };

function uid(): string {
	return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function keyHeaders(env: WorkerEnv): Record<string, string> {
	const headers: Record<string, string> = { apikey: env.SUPABASE_SECRET_KEY };
	// New sb_secret_ keys belong on the apikey header only. A legacy
	// service_role key is a JWT and still has to be the bearer token too.
	if (env.SUPABASE_SECRET_KEY.startsWith("eyJ")) {
		headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
	}
	return headers;
}

async function supabase(
	env: WorkerEnv,
	url: string,
	init: RequestInit & { returnRepresentation?: boolean } = {},
): Promise<unknown> {
	const headers: Record<string, string> = {
		...keyHeaders(env),
		"Content-Type": "application/json",
		...(init.headers as Record<string, string> | undefined),
	};
	if (init.returnRepresentation) headers["Prefer"] = "return=representation";
	const res = await fetch(url, { ...init, headers });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Supabase request failed (${res.status}): ${body}`);
	}
	if (res.status === 204) return null;
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

function rest(env: WorkerEnv, path: string, init?: RequestInit & { returnRepresentation?: boolean }) {
	return supabase(env, `${env.SUPABASE_URL}/rest/v1/${path}`, init);
}

const enc = encodeURIComponent;

/**
 * Resolves MCP_USER_EMAIL to an account and its board memberships.
 *
 * This is the whole access model for the connector. The secret key bypasses
 * row-level security, so nothing in the database stops a query from reaching
 * someone else's board — every tool below filters by the board ids returned
 * here, and never trusts a task or board id it was handed without checking it
 * against this list.
 */
async function loadScope(env: WorkerEnv): Promise<Scope> {
	if (!env.SUPABASE_SECRET_KEY || !env.MCP_USER_EMAIL) {
		throw new Error(
			"Pinboard connector isn't configured: set SUPABASE_SECRET_KEY and MCP_USER_EMAIL as Worker secrets.",
		);
	}
	const email = env.MCP_USER_EMAIL.trim().toLowerCase();
	const perPage = 200;
	let userId: string | undefined;
	for (let page = 1; !userId; page++) {
		const res = (await supabase(
			env,
			`${env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
		)) as { users?: { id: string; email?: string }[] };
		const users = res.users ?? [];
		userId = users.find((u) => (u.email ?? "").toLowerCase() === email)?.id;
		if (users.length < perPage) break;
	}
	if (!userId) {
		throw new Error(`No Pinboard account for ${email} — sign in to the board once with that email first.`);
	}

	const rows = (await rest(
		env,
		`board_members?user_id=eq.${userId}&select=role,boards(id,name,created_at)`,
	)) as { role: Board["role"]; boards: { id: string; name: string; created_at: string } | null }[];
	const boards = rows
		.filter((r) => r.boards)
		.map((r) => ({ id: r.boards!.id, name: r.boards!.name, created_at: r.boards!.created_at, role: r.role }))
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
	if (boards.length === 0) throw new Error(`${email} isn't a member of any board.`);
	return { userId, boards };
}

/** The personal board: the oldest board you own. */
function defaultBoard(scope: Scope): Board {
	return scope.boards.find((b) => b.role === "owner") ?? scope.boards[0];
}

function pickBoard(scope: Scope, board?: string): Board {
	if (!board || !board.trim()) return defaultBoard(scope);
	const wanted = board.trim();
	const byId = scope.boards.find((b) => b.id === wanted);
	if (byId) return byId;
	const byName = scope.boards.filter((b) => b.name.toLowerCase() === wanted.toLowerCase());
	if (byName.length === 1) return byName[0];
	const names = scope.boards.map((b) => `"${b.name}"`).join(", ");
	if (byName.length > 1) {
		throw new Error(`More than one board is called "${wanted}" — use its id from list_boards instead.`);
	}
	throw new Error(`No board called "${wanted}". Your boards: ${names}.`);
}

/** Fetches a task only if it sits on one of your boards. */
async function findTask(env: WorkerEnv, scope: Scope, id: string): Promise<Task> {
	const boardIds = scope.boards.map((b) => b.id).join(",");
	const rows = (await rest(env, `tasks?id=eq.${enc(id)}&board_id=in.(${boardIds})&select=*`)) as Task[];
	// Same message whether the task doesn't exist or belongs to someone else,
	// so the connector can't be used to probe for other people's task ids.
	if (!rows[0]) throw new Error(`No task found with id "${id}" on your boards.`);
	return rows[0];
}

function taskSummary(t: Task, scope: Scope) {
	return {
		id: t.id,
		title: t.title,
		area: t.area,
		status: t.status,
		notes: t.notes,
		parent_id: t.parent_id,
		board: scope.boards.find((b) => b.id === t.board_id)?.name ?? t.board_id,
		updated_at: t.updated_at,
	};
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const boardSchema = z
	.string()
	.optional()
	.describe("Board name or id. Defaults to your personal board. Use list_boards to see the options.");

function createServer(env: WorkerEnv) {
	const server = new McpServer({ name: "Pinboard", version: "1.1.0" });

	server.registerTool(
		"list_boards",
		{
			title: "List boards",
			description:
				"List the boards you can use — your personal board and any shared boards you're a member of. " +
				"Pass a board's name or id to the other tools to work on it.",
			inputSchema: z.object({}),
		},
		async () => {
			const scope = await loadScope(env);
			const fallback = defaultBoard(scope);
			return jsonResult(
				scope.boards.map((b) => ({ id: b.id, name: b.name, role: b.role, default: b.id === fallback.id })),
			);
		},
	);

	server.registerTool(
		"list_tasks",
		{
			title: "List tasks",
			description:
				"List tasks on a board, optionally filtered by column status and/or area. " +
				"Each task's parent_id is null for a top-level task, or the id of its parent task if it's a sub-task.",
			inputSchema: z.object({
				board: boardSchema,
				status: statusSchema.optional(),
				area: areaSchema.optional(),
			}),
		},
		async ({ board, status, area }) => {
			const scope = await loadScope(env);
			const target = pickBoard(scope, board);
			const params = new URLSearchParams({
				select: "*",
				board_id: `eq.${target.id}`,
				order: "updated_at.desc",
			});
			if (status) params.set("status", `eq.${status}`);
			if (area) params.set("area", `eq.${area}`);
			const rows = (await rest(env, `tasks?${params}`)) as Task[];
			return jsonResult(rows.map((t) => taskSummary(t, scope)));
		},
	);

	server.registerTool(
		"add_task",
		{
			title: "Add a top-level task",
			description: "Create a new top-level task on a board (not a sub-task of anything).",
			inputSchema: z.object({
				board: boardSchema,
				title: z.string().min(1).max(140),
				area: areaSchema,
				status: statusSchema.optional().describe("Defaults to backlog."),
				notes: z.string().max(4000).optional(),
			}),
		},
		async ({ board, title, area, status, notes }) => {
			const scope = await loadScope(env);
			const target = pickBoard(scope, board);
			const row = {
				id: uid(),
				title: title.trim(),
				area,
				status: status ?? "backlog",
				notes: notes ?? "",
				parent_id: null,
				board_id: target.id,
				created_by: scope.userId,
			};
			const created = (await rest(env, "tasks", {
				method: "POST",
				body: JSON.stringify(row),
				returnRepresentation: true,
			})) as Task[];
			return jsonResult(taskSummary(created[0], scope));
		},
	);

	server.registerTool(
		"add_subtask",
		{
			title: "Add a sub-task",
			description:
				"Create a sub-task under an existing top-level task. The sub-task goes on the same board as its parent " +
				"and inherits its area. Sub-tasks cannot themselves have sub-tasks (max 2 levels) — parent_id must " +
				"refer to a top-level task.",
			inputSchema: z.object({
				parent_id: z.string().describe("id of the top-level task this sub-task belongs under."),
				title: z.string().min(1).max(140),
				status: statusSchema.optional().describe("Defaults to backlog."),
				notes: z.string().max(4000).optional(),
			}),
		},
		async ({ parent_id, title, status, notes }) => {
			const scope = await loadScope(env);
			const parent = await findTask(env, scope, parent_id);
			if (parent.parent_id) {
				throw new Error(
					`"${parent.title}" is itself a sub-task — sub-tasks can't have sub-tasks (max 2 levels).`,
				);
			}
			const row = {
				id: uid(),
				title: title.trim(),
				area: parent.area,
				status: status ?? "backlog",
				notes: notes ?? "",
				parent_id: parent.id,
				board_id: parent.board_id,
				created_by: scope.userId,
			};
			const created = (await rest(env, "tasks", {
				method: "POST",
				body: JSON.stringify(row),
				returnRepresentation: true,
			})) as Task[];
			return jsonResult(taskSummary(created[0], scope));
		},
	);

	server.registerTool(
		"update_task",
		{
			title: "Update a task",
			description:
				"Edit a task's title, notes, status, or area. Only the fields you pass are changed. " +
				"To move a task to a different column, set status.",
			inputSchema: z.object({
				id: z.string(),
				title: z.string().min(1).max(140).optional(),
				notes: z.string().max(4000).optional(),
				status: statusSchema.optional(),
				area: areaSchema.optional(),
			}),
		},
		async ({ id, ...patch }) => {
			const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
			if (Object.keys(fields).length === 0) throw new Error("Nothing to update — pass at least one field.");
			const scope = await loadScope(env);
			const task = await findTask(env, scope, id);
			// Board filter repeated on the write itself, not just the lookup.
			const updated = (await rest(env, `tasks?id=eq.${enc(task.id)}&board_id=eq.${task.board_id}`, {
				method: "PATCH",
				body: JSON.stringify(fields),
				returnRepresentation: true,
			})) as Task[];
			if (updated.length === 0) throw new Error(`No task found with id "${id}" on your boards.`);
			return jsonResult(taskSummary(updated[0], scope));
		},
	);

	server.registerTool(
		"delete_task",
		{
			title: "Delete a task",
			description:
				"Delete a task by id. If it's a top-level task with sub-tasks, they are deleted too (cascade).",
			inputSchema: z.object({ id: z.string() }),
		},
		async ({ id }) => {
			const scope = await loadScope(env);
			const task = await findTask(env, scope, id);
			const children = (await rest(
				env,
				`tasks?parent_id=eq.${enc(task.id)}&board_id=eq.${task.board_id}&select=id`,
			)) as { id: string }[];
			await rest(env, `tasks?id=eq.${enc(task.id)}&board_id=eq.${task.board_id}`, { method: "DELETE" });
			const suffix = children.length
				? ` and its ${children.length} sub-task${children.length > 1 ? "s" : ""}`
				: "";
			return jsonResult({
				deleted: task.id,
				title: task.title,
				board: taskSummary(task, scope).board,
				message: `Deleted "${task.title}"${suffix}.`,
			});
		},
	);

	return server;
}

// Protected by OAuthProvider below — only ever invoked with a valid access token.
const mcpApiHandler: FetchHandler = {
	fetch(request, env, ctx) {
		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
};

function loginPage(actionUrl: string, clientName: string | undefined, error?: string): Response {
	const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — Pinboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700&family=Spectral:wght@400;600&family=DM+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  /* Same Chart Room tokens as the board itself. */
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;
    background:#ecdfba;color:#1c3a52;font-family:'Spectral',Georgia,serif;}
  .box{background:#e4d5a9;border:1px solid #c3b284;border-radius:10px;padding:28px 26px;width:100%;max-width:320px;text-align:center;}
  h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:700;margin:0 0 6px;}
  p{color:#3f5a67;font-size:13px;line-height:1.5;margin:0 0 16px;}
  input{width:100%;box-sizing:border-box;background:#f2e8c8;border:1px solid #c3b284;border-radius:7px;
    color:#1c3a52;padding:10px 12px;font-size:14px;text-align:center;font-family:'DM Mono',ui-monospace,monospace;letter-spacing:.08em;}
  input:focus{outline:2px solid #2f5d7a;outline-offset:1px;border-color:#2f5d7a;}
  button{width:100%;margin-top:10px;background:#1c3a52;color:#ecdfba;border:none;border-radius:7px;
    padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:'Spectral',Georgia,serif;}
  button:focus-visible{outline:2px solid #2f5d7a;outline-offset:2px;}
  .err{color:#a8402f;font-size:12px;margin-top:10px;min-height:14px;}
</style></head>
<body>
  <div class="box">
    <h1>Pinboard</h1>
    <p>${clientName ? `Allow "${escapeHtml(clientName)}" to manage your tasks?` : "Enter your password to continue"}</p>
    <form method="POST" action="${actionUrl}">
      <input type="password" name="password" autocomplete="current-password" autofocus>
      <button type="submit">Authorize</button>
      <div class="err">${error ? escapeHtml(error) : ""}</div>
    </form>
  </div>
</body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function authErrorResponse(error: unknown): Response {
	if (!(error instanceof AuthorizationError)) throw error;
	if (!error.redirectUri) return new Response(error.description, { status: 400 });
	const redirect = new URL(error.redirectUri);
	redirect.searchParams.set("error", error.code);
	redirect.searchParams.set("error_description", error.description);
	if (error.state) redirect.searchParams.set("state", error.state);
	if (error.issuer) redirect.searchParams.set("iss", error.issuer);
	return Response.redirect(redirect.toString(), 302);
}

const defaultHandler: FetchHandler = {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

		let oauthRequest: AuthRequest;
		try {
			oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error) {
			return authErrorResponse(error);
		}

		const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
		if (!client) return new Response("Unknown OAuth client", { status: 400 });

		const actionUrl = url.pathname + url.search;

		if (request.method === "GET") {
			return loginPage(actionUrl, client.clientName);
		}

		if (request.method === "POST") {
			const form = await request.formData();
			const password = form.get("password");
			if (typeof password !== "string" || password.length === 0 || password !== env.OWNER_PASSWORD) {
				return loginPage(actionUrl, client.clientName, "Incorrect password");
			}

			const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
				request: oauthRequest,
				userId: "owner",
				metadata: { clientName: client.clientName ?? "Unknown client" },
				scope: oauthRequest.scope,
				props: { owner: true } satisfies AuthProps,
			});
			return Response.redirect(redirectTo, 302);
		}

		return new Response("Method not allowed", { status: 405 });
	},
};

export default new OAuthProvider<WorkerEnv>({
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	scopesSupported: ["mcp"],
});
