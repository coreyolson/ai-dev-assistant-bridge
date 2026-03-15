/**
 * Language Model Tools
 * 
 * Registered with VS Code's Language Model Tool API so that agent-mode
 * Copilot can invoke them automatically during task execution.
 * 
 * Reporting tools:  report_completion, report_progress, report_observation
 * Query tools:      query_goltana, get_related_tasks
 * Approval tools:   request_approval
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as responseQueue from './responseQueue';
import * as aiQueue from './aiQueue';
import * as webhooks from './webhooks';
import { log } from './logging';
import { LogLevel } from './types';

// ─── Goltana HTTP helper ────────────────────────────────────────────────────

const GOLTANA_BASE = 'http://localhost:5100';

function goltanaRequest(method: string, path: string, body?: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : undefined;
		const url = new URL(path, GOLTANA_BASE);
		const opts: http.RequestOptions = {
			hostname: url.hostname,
			port: url.port,
			path: url.pathname + url.search,
			method,
			headers: {
				'Accept': 'application/json',
				...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
			},
			timeout: 15000,
		};
		const req = http.request(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString();
				try { resolve(JSON.parse(text)); } catch { resolve(text); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('Goltana request timed out')); });
		if (payload) { req.write(payload); }
		req.end();
	});
}

// ─── report_completion ──────────────────────────────────────────────────────

interface ReportCompletionInput {
	taskId: string;
	status: 'completed' | 'partial' | 'failed' | 'blocked';
	summary: string;
	findings?: string[];
	blockers?: string[];
	nextQuestions?: string[];
}

export class ReportCompletionTool implements vscode.LanguageModelTool<ReportCompletionInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReportCompletionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { taskId, status, summary, findings, blockers, nextQuestions } = options.input;

		log(LogLevel.INFO, `[LM Tool] report_completion invoked`, { taskId, status, summaryLen: summary.length });

		// Add to response queue
		const response = responseQueue.addResponse(taskId, status, summary, findings, blockers, nextQuestions);

		// Complete the queue item and its linked task if final
		if (status === 'completed' || status === 'failed') {
			const finalStatus = status === 'completed' ? 'completed' : 'failed';
			await aiQueue.completeQueueItem(taskId, finalStatus, summary);
		}

		// Fire webhook so Goltana gets notified immediately
		// Include queue item metadata so Goltana can route to originating conversation
		const queueItem = aiQueue.getInstruction(taskId);
		webhooks.fireWebhookEvent('response.created', { response, metadata: queueItem?.metadata });

		const msg = `Task ${taskId} reported as ${status}. Response ID: ${response.id}`;
		log(LogLevel.INFO, `[LM Tool] ${msg}`);

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(msg)
		]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReportCompletionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const { taskId, status } = options.input;
		return {
			invocationMessage: `Reporting completion for task ${taskId} (${status})`,
		};
	}
}

// ─── report_progress ────────────────────────────────────────────────────────

interface ReportProgressInput {
	taskId: string;
	update: string;
	percentComplete?: number;
}

export class ReportProgressTool implements vscode.LanguageModelTool<ReportProgressInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReportProgressInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { taskId, update, percentComplete } = options.input;

		log(LogLevel.INFO, `[LM Tool] report_progress invoked`, { taskId, percentComplete, updateLen: update.length });

		// Record heartbeat so stall detection knows the task is alive
		aiQueue.recordHeartbeat(taskId);

		// Add an in-progress response entry so it shows up in the response queue
		responseQueue.addResponse(taskId, 'in-progress', update);

		// Fire webhook so Goltana gets real-time visibility
		webhooks.fireWebhookEvent('task.progress', {
			taskId,
			update,
			percentComplete: percentComplete ?? null,
			timestamp: new Date().toISOString(),
		});

		const pct = percentComplete !== undefined ? ` (${percentComplete}%)` : '';
		const msg = `Progress recorded for task ${taskId}${pct}`;
		log(LogLevel.INFO, `[LM Tool] ${msg}`);

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(msg)
		]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReportProgressInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const { taskId, percentComplete } = options.input;
		const pct = percentComplete !== undefined ? ` (${percentComplete}%)` : '';
		return {
			invocationMessage: `Reporting progress for task ${taskId}${pct}`,
		};
	}
}

// ─── report_observation ─────────────────────────────────────────────────────

interface ReportObservationInput {
	taskId?: string;
	observation: string;
	severity?: 'info' | 'warning' | 'critical';
}

export class ReportObservationTool implements vscode.LanguageModelTool<ReportObservationInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReportObservationInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { taskId, observation, severity } = options.input;

		log(LogLevel.INFO, `[LM Tool] report_observation invoked`, { taskId, severity, len: observation.length });

		if (taskId) { aiQueue.recordHeartbeat(taskId); }

		webhooks.fireWebhookEvent('task.observation', {
			taskId: taskId ?? null,
			observation,
			severity: severity ?? 'info',
			timestamp: new Date().toISOString(),
		});

		const msg = `Observation recorded${taskId ? ` for task ${taskId}` : ''}: ${observation.slice(0, 120)}`;
		log(LogLevel.INFO, `[LM Tool] ${msg}`);

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(msg)
		]);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ReportObservationInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const sev = options.input.severity ?? 'info';
		return { invocationMessage: `Recording ${sev} observation` };
	}
}

// ─── query_goltana ──────────────────────────────────────────────────────────

interface QueryGoltanaInput {
	question: string;
	agentId?: string;
}

export class QueryGoltanaTool implements vscode.LanguageModelTool<QueryGoltanaInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<QueryGoltanaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { question, agentId } = options.input;
		const target = agentId ?? 'goltana';

		log(LogLevel.INFO, `[LM Tool] query_goltana invoked`, { target, questionLen: question.length });

		try {
			// Use the synthesize endpoint — synchronous JSON response
			const result = await goltanaRequest('POST', `/api/agents/${encodeURIComponent(target)}/synthesize`, {
				question,
			}) as Record<string, unknown>;

			const synthesis = typeof result.synthesis === 'string' ? result.synthesis : JSON.stringify(result);
			log(LogLevel.INFO, `[LM Tool] query_goltana got response (${synthesis.length} chars)`);

			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(synthesis)
			]);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(LogLevel.ERROR, `[LM Tool] query_goltana failed: ${errMsg}`);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Failed to reach Goltana: ${errMsg}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<QueryGoltanaInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const target = options.input.agentId ?? 'goltana';
		return { invocationMessage: `Querying ${target} for context...` };
	}
}

// ─── get_related_tasks ──────────────────────────────────────────────────────

interface GetRelatedTasksInput {
	agentId?: string;
	status?: 'pending' | 'running' | 'completed' | 'failed';
	limit?: number;
}

export class GetRelatedTasksTool implements vscode.LanguageModelTool<GetRelatedTasksInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetRelatedTasksInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { agentId, status, limit } = options.input;

		log(LogLevel.INFO, `[LM Tool] get_related_tasks invoked`, { agentId, status, limit });

		try {
			const params = new URLSearchParams();
			if (agentId) { params.set('agentId', agentId); }

			const tasks = await goltanaRequest('GET', `/api/tasks?${params.toString()}`) as Array<Record<string, unknown>>;

			// Filter by status client-side if requested
			let filtered = Array.isArray(tasks) ? tasks : [];
			if (status) { filtered = filtered.filter(t => t.status === status); }

			const cap = limit ?? 20;
			const result = filtered.slice(0, cap).map(t => ({
				id: t.id, title: t.title, status: t.status, priority: t.priority, agentId: t.agent_id ?? t.agentId,
			}));

			const summary = `Found ${filtered.length} task(s)${status ? ` with status '${status}'` : ''}. Showing ${result.length}.`;
			log(LogLevel.INFO, `[LM Tool] ${summary}`);

			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(summary + '\n\n' + JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(LogLevel.ERROR, `[LM Tool] get_related_tasks failed: ${errMsg}`);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Failed to fetch tasks from Goltana: ${errMsg}`)
			]);
		}
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<GetRelatedTasksInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Fetching related tasks from Goltana...' };
	}
}

// ─── request_approval ───────────────────────────────────────────────────────

interface RequestApprovalInput {
	title: string;
	context: string;
	agentId?: string;
	blocking?: boolean;
}

export class RequestApprovalTool implements vscode.LanguageModelTool<RequestApprovalInput> {

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RequestApprovalInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { title, context, agentId, blocking } = options.input;

		log(LogLevel.INFO, `[LM Tool] request_approval invoked`, { title, agentId, blocking });

		try {
			const result = await goltanaRequest('POST', '/api/inbox', {
				title,
				context,
				agentId: agentId ?? 'copilot-bridge',
				blocking: blocking ?? true,
			}) as Record<string, unknown>;

			const itemId = result.id ?? result.inboxId ?? 'unknown';

			// Also fire webhook for immediate visibility
			webhooks.fireWebhookEvent('approval.requested', {
				inboxId: itemId,
				title,
				context,
				agentId: agentId ?? 'copilot-bridge',
				blocking: blocking ?? true,
				timestamp: new Date().toISOString(),
			});

			const msg = `Approval requested: "${title}" (inbox ID: ${itemId}). Goltana will review.`;
			log(LogLevel.INFO, `[LM Tool] ${msg}`);

			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(msg)
			]);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log(LogLevel.ERROR, `[LM Tool] request_approval failed: ${errMsg}`);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Failed to submit approval request: ${errMsg}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<RequestApprovalInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Requesting approval: ${options.input.title}`,
			confirmationMessages: {
				title: 'Request Approval from Goltana',
				message: new vscode.MarkdownString(
					`**${options.input.title}**\n\n${options.input.context}\n\nThis will create an inbox item for Goltana to review.`
				),
			},
		};
	}
}
