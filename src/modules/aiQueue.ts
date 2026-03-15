/**
 * AI Communication Queue Module
 * 
 * Manages a queue of instructions/commands from external AI systems
 * that can be sent to the AI agent in VS Code. This allows other
 * applications to communicate with the VS Code AI agent asynchronously.
 * 
 * Use Cases:
 * - External AI agents sending instructions
 * - Multi-agent coordination systems
 * - Automated workflow triggers
 * - Cross-application AI communication
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { log } from './logging';
import { LogLevel } from './types';
import * as responseQueue from './responseQueue';
import * as webhooks from './webhooks';

/**
 * Queue instruction interface
 */
export interface QueueInstruction {
	id: string;
	instruction: string;
	priority: 'low' | 'normal' | 'high' | 'urgent';
	source: string;
	timestamp: string;
	status: 'pending' | 'processing' | 'completed' | 'failed' | 'stalled';
	claimedAt?: string;
	lastHeartbeat?: string;
	result?: string;
	error?: string;
	metadata?: Record<string, unknown>;
	linkedTaskId?: string;
	requeueCount?: number;
}

/**
 * In-memory queue storage
 */
let instructionQueue: QueueInstruction[] = [];
let processingActive = false;
let autoProcessEnabled = false;
let autoProcessCallback: ((message: string, context?: unknown) => Promise<boolean>) | undefined;
let linkedTaskCallback: ((taskId: string) => Promise<void>) | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let stallCheckInterval: ReturnType<typeof setInterval> | undefined;

const STALL_TIMEOUT_MS = 15 * 60 * 1000;   // 15 minutes with no heartbeat → stalled
const REQUEUE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes stalled → re-queue
const DEDUP_WINDOW_MS = 10 * 60 * 1000;    // Reject duplicate instructions within 10min
const MAX_QUEUE_SIZE = 50;                 // Reject enqueue when queue exceeds this
const MAX_REQUEUE_COUNT = 3;               // Permanently fail after this many re-queues

// Track recent instruction hashes for dedup
const recentInstructionHashes = new Map<string, number>();

/**
 * Initialize queue with persistence context
 */
export function initQueue(context: vscode.ExtensionContext): void {
	extensionContext = context;
	loadQueue();
	startStallDetection();
	context.subscriptions.push({ dispose: () => { if (stallCheckInterval) { clearInterval(stallCheckInterval); } } });
}

/** Persist queue to globalState */
function saveQueue(): void {
	if (!extensionContext) { return; }
	extensionContext.globalState.update('aiQueue', instructionQueue);
}

/** Load queue from globalState, reset interrupted tasks */
function loadQueue(): void {
	if (!extensionContext) { return; }
	const saved = extensionContext.globalState.get<QueueInstruction[]>('aiQueue');
	if (Array.isArray(saved) && saved.length > 0) {
		instructionQueue = saved;
		// Tasks that were processing at shutdown get re-queued
		for (const item of instructionQueue) {
			if (item.status === 'processing' || item.status === 'stalled') {
				item.status = 'pending';
				item.claimedAt = undefined;
				item.lastHeartbeat = undefined;
			}
		}
		saveQueue();
		log(LogLevel.INFO, `Loaded ${instructionQueue.length} instructions from persistent storage`);
	}
}

/**
 * Add instruction to queue
 * @param instruction - The instruction text to send to AI
 * @param source - Source identifier (e.g., 'external-app', 'automation')
 * @param priority - Priority level (default: 'normal')
 * @param metadata - Optional metadata for context
 * @returns The created queue instruction
 */
export function enqueueInstruction(
	instruction: string,
	source: string,
	priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal',
	metadata?: Record<string, unknown>,
	linkedTaskId?: string
): QueueInstruction | null {
	// Dedup: reject identical instructions within dedup window
	const hash = crypto.createHash('sha256').update(instruction).digest('hex').slice(0, 16);
	const now = Date.now();
	const lastSeen = recentInstructionHashes.get(hash);
	if (lastSeen && (now - lastSeen) < DEDUP_WINDOW_MS) {
		log(LogLevel.WARN, `Rejected duplicate instruction within ${DEDUP_WINDOW_MS / 1000}s window`, { hash, source });
		return null;
	}

	// Overflow protection: reject when active queue is too large
	const activeCount = instructionQueue.filter(i => i.status === 'pending' || i.status === 'processing' || i.status === 'stalled').length;
	if (activeCount >= MAX_QUEUE_SIZE) {
		log(LogLevel.ERROR, `Queue overflow: ${activeCount} active items (max ${MAX_QUEUE_SIZE}). Rejecting instruction.`, { source });
		return null;
	}

	recentInstructionHashes.set(hash, now);

	// Prune old dedup entries
	for (const [h, ts] of recentInstructionHashes) {
		if (now - ts > DEDUP_WINDOW_MS) { recentInstructionHashes.delete(h); }
	}

	const queueItem: QueueInstruction = {
		id: generateId(),
		instruction,
		priority,
		source,
		timestamp: new Date().toISOString(),
		status: 'pending',
		metadata,
		linkedTaskId
	};
	
	instructionQueue.push(queueItem);
	sortQueueByPriority();
	saveQueue();
	
	log(LogLevel.INFO, `Enqueued instruction from ${source}`, { id: queueItem.id, priority });
	
	// Trigger auto-process if enabled
	if (autoProcessEnabled && autoProcessCallback) {
		void processNextInstruction(autoProcessCallback);
	}
	
	return queueItem;
}

/**
 * Get all instructions in queue
 * @param status - Optional status filter
 * @returns Array of queue instructions
 */
export function getQueue(status?: 'pending' | 'processing' | 'completed' | 'failed'): QueueInstruction[] {
	if (status) {
		return instructionQueue.filter(item => item.status === status);
	}
	return [...instructionQueue];
}

/**
 * Get a specific instruction by ID
 * @param id - Instruction ID
 * @returns Queue instruction or undefined
 */
export function getInstruction(id: string): QueueInstruction | undefined {
	return instructionQueue.find(item => item.id === id);
}

/**
 * Remove instruction from queue
 * @param id - Instruction ID
 * @returns true if removed, false if not found
 */
export function removeInstruction(id: string): boolean {
	const index = instructionQueue.findIndex(item => item.id === id);
	if (index !== -1) {
		instructionQueue.splice(index, 1);
		saveQueue();
		log(LogLevel.INFO, `Removed instruction from queue: ${id}`);
		return true;
	}
	return false;
}

/**
 * Clear completed and failed instructions
 * @returns Number of instructions cleared
 */
export function clearProcessed(): number {
	const beforeLength = instructionQueue.length;
	instructionQueue = instructionQueue.filter(
		item => item.status === 'pending' || item.status === 'processing' || item.status === 'stalled'
	);
	const cleared = beforeLength - instructionQueue.length;
	saveQueue();
	log(LogLevel.INFO, `Cleared ${cleared} processed instructions`);
	return cleared;
}

/**
 * Clear all instructions from queue
 */
export function clearQueue(): void {
	const count = instructionQueue.length;
	instructionQueue = [];
	saveQueue();
	log(LogLevel.INFO, `Cleared all ${count} instructions from queue`);
}

/**
 * Process next pending instruction
 * @param sendToAgent - Function to send message to AI agent
 * @returns true if instruction was processed, false if queue is empty
 */
export async function processNextInstruction(
	sendToAgent?: (message: string, context?: unknown) => Promise<boolean>
): Promise<boolean> {
	if (processingActive) {
		log(LogLevel.WARN, 'Already processing an instruction — skipping');
		return false;
	}
	
	const pending = instructionQueue.find(item => item.status === 'pending');
	if (!pending) {
		log(LogLevel.DEBUG, 'No pending instructions in queue');
		return false;
	}
	
	processingActive = true;
	pending.status = 'processing';
	pending.claimedAt = new Date().toISOString();
	pending.lastHeartbeat = new Date().toISOString();
	saveQueue();
	
	try {
		log(LogLevel.INFO, `Processing instruction: ${pending.id}`);
		
		if (sendToAgent) {
			const success = await sendToAgent(pending.instruction, {
				source: pending.source,
				queueId: pending.id,
				priority: pending.priority,
				linkedTaskId: pending.linkedTaskId,
				metadata: pending.metadata
			});
			
			if (success) {
				// Keep as 'processing' — actual completion happens when the
				// agent POSTs to /responses after finishing the work
				log(LogLevel.INFO, `Instruction sent to agent, awaiting response: ${pending.id}`);

				// Notify Goltana that the instruction was successfully pasted into Chat
				webhooks.fireWebhookEvent('task.dispatched', {
					queueId: pending.id,
					linkedTaskId: pending.linkedTaskId,
					source: pending.source,
					instruction: pending.instruction.slice(0, 200),
					dispatchedAt: new Date().toISOString(),
				});
			} else {
				pending.status = 'failed';
				pending.error = 'Failed to send to AI agent';
			}
		} else {
			pending.status = 'completed';
			pending.result = 'Marked as processed (no agent function provided)';
		}
		
		log(LogLevel.INFO, `Instruction ${pending.status}: ${pending.id}`);

		// Only create immediate response/completion for failure or no-agent cases
		if (pending.status === 'failed') {
			responseQueue.addResponse(
				pending.id,
				'failed',
				pending.error ?? 'Task processing failed',
				undefined,
				[pending.error ?? 'Unknown error'],
			);
		} else if (pending.status === 'completed') {
			responseQueue.addResponse(
				pending.id,
				'completed',
				pending.result ?? 'Task processed by VS Code agent',
			);
			if (pending.linkedTaskId && linkedTaskCallback) {
				try {
					await linkedTaskCallback(pending.linkedTaskId);
					log(LogLevel.INFO, `Auto-completed linked task ${pending.linkedTaskId} for queue item ${pending.id}`);
				} catch (err) {
					log(LogLevel.WARN, `Failed to auto-complete linked task ${pending.linkedTaskId}`, { error: err instanceof Error ? err.message : String(err) });
				}
			}
		}
		
	} catch (error) {
		pending.status = 'failed';
		pending.error = error instanceof Error ? error.message : String(error);
		log(LogLevel.ERROR, `Error processing instruction ${pending.id}`, { error: pending.error });
		responseQueue.addResponse(
			pending.id,
			'failed',
			`Processing error: ${pending.error}`,
			undefined,
			[pending.error],
		);
	} finally {
		// Only release the processing gate when the task won't continue running.
		// Tasks that are successfully sent to the agent stay 'processing' until
		// completeQueueItem() is called (via report_completion / POST /responses).
		if (pending.status === 'failed' || pending.status === 'completed') {
			processingActive = false;
		}
		saveQueue();
	}
	
	return true;
}

/**
 * Process all pending instructions
 * @param sendToAgent - Function to send message to AI agent
 * @returns Number of instructions processed
 */
export async function processAllInstructions(
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): Promise<number> {
	let processed = 0;
	
	while (getQueue('pending').length > 0 && !processingActive) {
		const success = await processNextInstruction(sendToAgent);
		if (success) {
			processed++;
			// Small delay between instructions to avoid overwhelming the agent
			await new Promise(resolve => setTimeout(resolve, 500));
		} else {
			break;
		}
	}
	
	log(LogLevel.INFO, `Processed ${processed} instructions`);
	return processed;
}

/**
 * Enable or disable auto-processing of queue
 * @param enabled - true to enable, false to disable
 * @param sendToAgent - Function to send message to AI agent (required if enabling)
 */
export function setAutoProcess(
	enabled: boolean,
	sendToAgent?: (message: string, context?: unknown) => Promise<boolean>
): void {
	autoProcessEnabled = enabled;
	autoProcessCallback = enabled ? sendToAgent : undefined;
	log(LogLevel.INFO, `Auto-process ${enabled ? 'enabled' : 'disabled'}`);
	
	if (enabled && sendToAgent) {
		// Start processing if there are pending instructions
		void processAllInstructions(sendToAgent);
	}
}

/**
 * Set callback for auto-completing linked tasks when queue items complete
 */
export function setLinkedTaskCallback(cb: (taskId: string) => Promise<void>): void {
	linkedTaskCallback = cb;
}

/**
 * Complete a queue item externally (called when agent POSTs to /responses).
 * Also auto-completes the linked task if the queue item has one.
 */
export async function completeQueueItem(
	queueId: string,
	status: 'completed' | 'failed' = 'completed',
	result?: string
): Promise<QueueInstruction | undefined> {
	const item = instructionQueue.find(i => i.id === queueId);
	if (!item || (item.status !== 'processing' && item.status !== 'stalled')) {
		return undefined;
	}

	item.status = status;
	if (result) { item.result = result; }

	// Release the serial processing gate so the next pending item can start
	processingActive = false;
	saveQueue();
	log(LogLevel.INFO, `Queue item ${queueId} externally marked ${status}`);

	if (status === 'completed' && item.linkedTaskId && linkedTaskCallback) {
		try {
			await linkedTaskCallback(item.linkedTaskId);
			log(LogLevel.INFO, `Auto-completed linked task ${item.linkedTaskId} for queue item ${queueId}`);
		} catch (err) {
			log(LogLevel.WARN, `Failed to auto-complete linked task ${item.linkedTaskId}`, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Kick off next pending item now that the gate is released
	if (autoProcessEnabled && autoProcessCallback) {
		const hasPending = instructionQueue.some(i => i.status === 'pending');
		if (hasPending) { void processNextInstruction(autoProcessCallback); }
	}

	return item;
}

/**
 * Get queue statistics
 * @returns Object with queue statistics
 */
export function getQueueStats(): {
	total: number;
	pending: number;
	processing: number;
	completed: number;
	failed: number;
	stalled: number;
	autoProcessEnabled: boolean;
	processingGateLocked: boolean;
} {
	return {
		total: instructionQueue.length,
		pending: instructionQueue.filter(i => i.status === 'pending').length,
		processing: instructionQueue.filter(i => i.status === 'processing').length,
		completed: instructionQueue.filter(i => i.status === 'completed').length,
		failed: instructionQueue.filter(i => i.status === 'failed').length,
		stalled: instructionQueue.filter(i => i.status === 'stalled').length,
		autoProcessEnabled,
		processingGateLocked: processingActive
	};
}

/**
 * Sort queue by priority (urgent > high > normal > low)
 */
function sortQueueByPriority(): void {
	const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
	instructionQueue.sort((a, b) => {
		// First by status (pending first)
		if (a.status === 'pending' && b.status !== 'pending') {
			return -1;
		}
		if (a.status !== 'pending' && b.status === 'pending') {
			return 1;
		}
		
		// Then by priority
		const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
		if (priorityDiff !== 0) {
			return priorityDiff;
		}
		
		// Finally by timestamp (older first)
		return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
	});
}

/**
 * Generate unique ID for instruction
 */
function generateId(): string {
	return `ai-queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Record heartbeat for a processing instruction
 */
export function recordHeartbeat(id: string): boolean {
	const item = instructionQueue.find(i => i.id === id);
	if (!item || (item.status !== 'processing' && item.status !== 'stalled')) { return false; }
	item.lastHeartbeat = new Date().toISOString();
	if (item.status === 'stalled') {
		item.status = 'processing';
		log(LogLevel.INFO, `Instruction ${id} recovered from stalled → processing`);
	}
	saveQueue();
	return true;
}

/**
 * Get instructions that are not yet finalized (pending + processing + stalled)
 */
export function getPendingInstructions(): QueueInstruction[] {
	return instructionQueue.filter(i => i.status === 'pending' || i.status === 'processing' || i.status === 'stalled');
}

/**
 * Reset the processing gate if it's stuck (no items actually processing).
 * Returns true if the gate was stuck and got reset.
 */
export function resetProcessingGateIfStuck(): boolean {
	if (!processingActive) { return false; }
	const hasProcessing = instructionQueue.some(i => i.status === 'processing');
	if (hasProcessing) { return false; }
	// Gate is stuck: processingActive=true but no item is 'processing'
	processingActive = false;
	log(LogLevel.WARN, 'Reset stuck processingActive gate (no items in processing state)');
	return true;
}

/**
 * Get stalled instructions
 */
export function getStalledInstructions(): QueueInstruction[] {
	return instructionQueue.filter(i => i.status === 'stalled');
}

/**
 * Stall detection loop — marks processing items as stalled if heartbeat is old,
 * re-queues stalled items after extended timeout
 */
function startStallDetection(): void {
	if (stallCheckInterval) { clearInterval(stallCheckInterval); }
	stallCheckInterval = setInterval(() => {
		const now = Date.now();
		let changed = false;

		for (const item of instructionQueue) {
			if (item.status === 'processing' && item.lastHeartbeat) {
				const elapsed = now - new Date(item.lastHeartbeat).getTime();
				if (elapsed > STALL_TIMEOUT_MS) {
					item.status = 'stalled';
					// Release processing gate immediately so other pending items can proceed
					processingActive = false;
					log(LogLevel.WARN, `Instruction ${item.id} stalled (no heartbeat for ${Math.round(elapsed / 1000)}s)`);
					webhooks.fireWebhookEvent('task.stalled', {
						queueId: item.id,
						linkedTaskId: item.linkedTaskId,
						source: item.source,
						instruction: item.instruction.slice(0, 200),
						stalledAt: new Date().toISOString(),
						requeueCount: item.requeueCount ?? 0,
					});
					changed = true;
				}
			}
			if (item.status === 'stalled' && item.lastHeartbeat) {
				const elapsed = now - new Date(item.lastHeartbeat).getTime();
				if (elapsed > REQUEUE_TIMEOUT_MS) {
					const count = (item.requeueCount ?? 0) + 1;
					item.requeueCount = count;

					if (count > MAX_REQUEUE_COUNT) {
						// Permanently fail after too many re-queues
						item.status = 'failed';
						item.error = `Permanently failed after ${count - 1} re-queue attempts`;
						processingActive = false;
						log(LogLevel.ERROR, `Instruction ${item.id} permanently failed after ${count - 1} re-queues`);
						webhooks.fireWebhookEvent('task.failed', {
							queueId: item.id,
							linkedTaskId: item.linkedTaskId,
							source: item.source,
							instruction: item.instruction.slice(0, 200),
							failedAt: new Date().toISOString(),
							reason: item.error,
							requeueCount: count - 1,
						});
						responseQueue.addResponse(
							item.id,
							'failed',
							item.error,
							undefined,
							[item.error],
						);
					} else {
						item.status = 'pending';
						item.claimedAt = undefined;
						item.lastHeartbeat = undefined;
						processingActive = false;
						log(LogLevel.WARN, `Instruction ${item.id} re-queued (attempt ${count}/${MAX_REQUEUE_COUNT}) after ${Math.round(elapsed / 1000)}s stall`);
					}
					changed = true;
				}
			}
		}

		if (changed) {
			saveQueue();
			// Trigger auto-process for any re-queued items
			if (autoProcessEnabled && autoProcessCallback) {
				const hasPending = instructionQueue.some(i => i.status === 'pending');
				if (hasPending) { void processNextInstruction(autoProcessCallback); }
			}
		}

		// Safety: if processingActive is true but nothing is actually processing, reset
		resetProcessingGateIfStuck();
	}, 60_000); // Check every 60 seconds
}
