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
	SUPABASE_ANON_KEY: string;
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
	created_at: string;
	updated_at: string;
};

function uid(): string {
	return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function sb(
	env: WorkerEnv,
	path: string,
	init: RequestInit & { returnRepresentation?: boolean } = {},
): Promise<unknown> {
	const headers: Record<string, string> = {
		apikey: env.SUPABASE_ANON_KEY,
		Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
		"Content-Type": "application/json",
		...(init.headers as Record<string, string> | undefined),
	};
	if (init.returnRepresentation) headers["Prefer"] = "return=representation";
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Supabase request failed (${res.status}): ${body}`);
	}
	if (res.status === 204) return null;
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

function taskSummary(t: Task) {
	return {
		id: t.id,
		title: t.title,
		area: t.area,
		status: t.status,
		notes: t.notes,
		parent_id: t.parent_id,
		updated_at: t.updated_at,
	};
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createServer(env: WorkerEnv) {
	const server = new McpServer({ name: "Kanban Board (Command Deck)", version: "1.0.0" });

	server.registerTool(
		"list_tasks",
		{
			title: "List tasks",
			description:
				"List tasks on the kanban board, optionally filtered by column status and/or area. " +
				"Each task's parent_id is null for a top-level task, or the id of its parent task if it's a sub-task.",
			inputSchema: z.object({
				status: statusSchema.optional(),
				area: areaSchema.optional(),
			}),
		},
		async ({ status, area }) => {
			const params = new URLSearchParams({ select: "*", order: "updated_at.desc" });
			if (status) params.set("status", `eq.${status}`);
			if (area) params.set("area", `eq.${area}`);
			const rows = (await sb(env, `tasks?${params}`)) as Task[];
			return jsonResult(rows.map(taskSummary));
		},
	);

	server.registerTool(
		"add_task",
		{
			title: "Add a top-level task",
			description: "Create a new top-level task on the board (not a sub-task of anything).",
			inputSchema: z.object({
				title: z.string().min(1).max(140),
				area: areaSchema,
				status: statusSchema.optional().describe("Defaults to backlog."),
				notes: z.string().max(4000).optional(),
			}),
		},
		async ({ title, area, status, notes }) => {
			const row = {
				id: uid(),
				title: title.trim(),
				area,
				status: status ?? "backlog",
				notes: notes ?? "",
				parent_id: null,
			};
			const created = (await sb(env, "tasks", {
				method: "POST",
				body: JSON.stringify(row),
				returnRepresentation: true,
			})) as Task[];
			return jsonResult(taskSummary(created[0]));
		},
	);

	server.registerTool(
		"add_subtask",
		{
			title: "Add a sub-task",
			description:
				"Create a sub-task under an existing top-level task. The sub-task inherits its parent's area. " +
				"Sub-tasks cannot themselves have sub-tasks (max 2 levels) — parent_id must refer to a top-level task.",
			inputSchema: z.object({
				parent_id: z.string().describe("id of the top-level task this sub-task belongs under."),
				title: z.string().min(1).max(140),
				status: statusSchema.optional().describe("Defaults to backlog."),
				notes: z.string().max(4000).optional(),
			}),
		},
		async ({ parent_id, title, status, notes }) => {
			const parents = (await sb(
				env,
				`tasks?id=eq.${encodeURIComponent(parent_id)}&select=*`,
			)) as Task[];
			const parent = parents[0];
			if (!parent) throw new Error(`No task found with id "${parent_id}".`);
			if (parent.parent_id)
				throw new Error(
					`"${parent.title}" is itself a sub-task — sub-tasks can't have sub-tasks (max 2 levels).`,
				);
			const row = {
				id: uid(),
				title: title.trim(),
				area: parent.area,
				status: status ?? "backlog",
				notes: notes ?? "",
				parent_id: parent.id,
			};
			const created = (await sb(env, "tasks", {
				method: "POST",
				body: JSON.stringify(row),
				returnRepresentation: true,
			})) as Task[];
			return jsonResult(taskSummary(created[0]));
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
			const updated = (await sb(env, `tasks?id=eq.${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: JSON.stringify(fields),
				returnRepresentation: true,
			})) as Task[];
			if (updated.length === 0) throw new Error(`No task found with id "${id}".`);
			return jsonResult(taskSummary(updated[0]));
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
			const existing = (await sb(env, `tasks?id=eq.${encodeURIComponent(id)}&select=*`)) as Task[];
			const task = existing[0];
			if (!task) throw new Error(`No task found with id "${id}".`);
			const children = (await sb(
				env,
				`tasks?parent_id=eq.${encodeURIComponent(id)}&select=id`,
			)) as { id: string }[];
			await sb(env, `tasks?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
			const suffix = children.length
				? ` and its ${children.length} sub-task${children.length > 1 ? "s" : ""}`
				: "";
			return jsonResult({ deleted: task.id, title: task.title, message: `Deleted "${task.title}"${suffix}.` });
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
<title>Authorize — Command Deck</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#11141b;color:#e9ebf1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  .box{background:#181c26;border:1px solid #2a3040;border-radius:10px;padding:28px 26px;width:100%;max-width:300px;text-align:center;}
  h1{font-size:17px;margin:0 0 4px;}
  p{color:#8a91a6;font-size:13px;margin:0 0 16px;}
  input{width:100%;box-sizing:border-box;background:#1f2430;border:1px solid #2a3040;border-radius:7px;
    color:#e9ebf1;padding:10px 12px;font-size:14px;text-align:center;}
  input:focus{outline:none;border-color:#5c6376;}
  button{width:100%;margin-top:10px;background:#e9ebf1;color:#11141b;border:none;border-radius:7px;
    padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;}
  .err{color:#ef5b5b;font-size:12px;margin-top:10px;min-height:14px;}
</style></head>
<body>
  <div class="box">
    <h1>Command Deck</h1>
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
