/**
 * Response Queue Module
 * 
 * Manages structured responses from VS Code back to external AI systems.
 * This closes the feedback loop: external systems submit tasks via /tasks,
 * VS Code processes them, and posts results back via /responses.
 * 
 * The external system (e.g., Goltana) polls GET /responses to retrieve
 * pending responses and act on findings.
 */

import { log } from './logging';
import { LogLevel } from './types';

/**
 * Structured response from VS Code back to the task submitter
 */
export interface TaskResponse {
	id: string;
	taskId: string;
	status: 'completed' | 'partial' | 'failed' | 'blocked' | 'in-progress';
	summary: string;
	findings?: string[];
	blockers?: string[];
	nextQuestions?: string[];
	timestamp: string;
	read: boolean;
}

/** In-memory response queue */
let responseQueue: TaskResponse[] = [];

/**
 * Add a response to the queue
 */
export function addResponse(
	taskId: string,
	status: TaskResponse['status'],
	summary: string,
	findings?: string[],
	blockers?: string[],
	nextQuestions?: string[]
): TaskResponse {
	const response: TaskResponse = {
		id: `resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId,
		status,
		summary,
		findings,
		blockers,
		nextQuestions,
		timestamp: new Date().toISOString(),
		read: false
	};

	responseQueue.push(response);
	log(LogLevel.INFO, `Response queued for task ${taskId}`, { id: response.id, status });
	return response;
}

/**
 * Get pending (unread) responses and mark them as read
 */
export function getPendingResponses(): TaskResponse[] {
	const pending = responseQueue.filter(r => !r.read);
	for (const r of pending) {
		r.read = true;
	}
	log(LogLevel.INFO, `Returned ${pending.length} pending responses`);
	return pending;
}

/**
 * Get all responses (optionally filtered by taskId)
 */
export function getAllResponses(taskId?: string): TaskResponse[] {
	if (taskId) {
		return responseQueue.filter(r => r.taskId === taskId);
	}
	return [...responseQueue];
}

/**
 * Clear read responses older than maxAge milliseconds
 */
export function clearOldResponses(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
	const cutoff = Date.now() - maxAgeMs;
	const before = responseQueue.length;
	responseQueue = responseQueue.filter(
		r => !r.read || new Date(r.timestamp).getTime() > cutoff
	);
	const cleared = before - responseQueue.length;
	if (cleared > 0) {
		log(LogLevel.INFO, `Cleared ${cleared} old responses`);
	}
	return cleared;
}

/**
 * Get response queue stats
 */
export function getResponseStats(): { total: number; pending: number; read: number } {
	const pending = responseQueue.filter(r => !r.read).length;
	return {
		total: responseQueue.length,
		pending,
		read: responseQueue.length - pending
	};
}
