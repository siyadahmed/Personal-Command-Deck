import {
	McpServer,
	OAuthError,
	OAuthErrorCode,
	bearerAuthChallengeResponse,
	requireBearerAuth,
	type AuthInfo,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface WorkerEnv {
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	MCP_TOKEN: string;
}

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

function makeVerifier(env: WorkerEnv): OAuthTokenVerifier {
	return {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			if (!env.MCP_TOKEN || token !== env.MCP_TOKEN) {
				throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or missing bearer token");
			}
			return {
				token,
				clientId: "kanban-board-owner",
				scopes: ["mcp"],
				// Static personal token — far-future expiry rather than real rotation.
				expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10,
			};
		},
	};
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		const gate = requireBearerAuth({ verifier: makeVerifier(env) });
		const authResult = await gate(request);
		if (authResult instanceof Response) return authResult;

		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;
