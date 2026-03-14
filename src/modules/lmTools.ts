/**
 * Language Model Tools — report_completion & report_progress
 * 
 * These tools are registered with VS Code's Language Model Tool API so that
 * agent-mode Copilot can invoke them automatically during task execution.
 * They close the feedback loop back to Goltana via the Bridge's response
 * queue and webhook system.
 */

import * as vscode from 'vscode';
import * as responseQueue from './responseQueue';
import * as aiQueue from './aiQueue';
import * as webhooks from './webhooks';
import { log } from './logging';
import { LogLevel } from './types';

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
		webhooks.fireWebhookEvent('response.created', { response });

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
