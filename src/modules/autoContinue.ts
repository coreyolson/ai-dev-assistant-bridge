/**
 * Auto-Continue Module
 * 
 * Manages periodic reminder system that automatically sends messages
 * to the AI agent based on category-specific intervals and configurations.
 * 
 * Features:
 * - Category-based reminders (tasks, improvements, coverage, robustness, cleanup, commits)
 * - Configurable intervals per category (in seconds)
 * - Smart message rotation (only sends when interval elapsed)
 * - Persistent state tracking (last sent times)
 * - Live countdown display in status bar
 * - Manual trigger support (force send all enabled categories)
 */

import * as vscode from 'vscode';
import { LogLevel, CustomCategory } from './types';
import { log, getErrorMessage } from './logging';
import * as guidingDocuments from './guidingDocuments';
import * as taskManager from './taskManager';
import { getCustomCategories } from './customCategories';
import { formatCountdown } from './timeFormatting';
import { isProcessingActive } from './aiQueue';
import { isSendingActive } from './chatIntegration';

let autoContinueTimer: NodeJS.Timeout | undefined;

/**
 * Get smart auto-continue message by rotating through enabled categories
 * 
 * @param context - VS Code extension context for state persistence
 * @param getConfig - Function that returns current workspace configuration
 * @param force - If true, sends all enabled categories regardless of interval (default: false)
 * @returns Promise resolving to combined message string, or empty string if no categories due
 * 
 * @remarks
 * Message generation strategy:
 * 1. Iterates through all 6 categories (tasks, improvements, coverage, robustness, cleanup, commits)
 * 2. For each enabled category, checks if interval has elapsed since last sent
 * 3. Includes category message if interval elapsed OR force=true
 * 4. Updates last sent timestamp for included categories
 * 5. Combines messages with newlines if multiple categories due
 * 6. Returns empty string if no categories ready (prevents unnecessary agent calls)
 * 
 * State tracking:
 * - Last sent times stored in globalState under 'autoContinue.lastSent'
 * - Timestamps persisted across sessions
 * - Per-category tracking allows independent intervals
 * 
 * @example
 * ```typescript
 * // Normal auto-continue (respects intervals)
 * const message = await getSmartAutoContinueMessage(context, getConfig);
 * if (message) {
 *   await sendToAgent(message);
 * }
 * 
 * // Force send all enabled categories (manual trigger)
 * const message = await getSmartAutoContinueMessage(context, getConfig, true);
 * await sendToAgent(message);
 * ```
 */
export async function getSmartAutoContinueMessage(
	context: vscode.ExtensionContext,
	getConfig: () => vscode.WorkspaceConfiguration,
	force: boolean = false
): Promise<string> {
	const config = getConfig();
	const categories = ['tasks', 'improvements', 'coverage', 'robustness', 'cleanup', 'commits'];
	const now = Date.now();
	const messages: string[] = [];
	
	// Track last sent times in global state
	const lastSentKey = 'autoContinue.lastSent';
	const lastSent = context.globalState.get<Record<string, number>>(lastSentKey, {});
	const newLastSent: Record<string, number> = { ...lastSent };
	
	// Process built-in categories
	for (const category of categories) {
		const enabled = config.get<boolean>(`autoContinue.${category}.enabled`, true);
		const interval = config.get<number>(`autoContinue.${category}.interval`, 300);
		const message = config.get<string>(`autoContinue.${category}.message`, '');
		
		if (!enabled || !message) {
			continue;
		}
		
		const lastSentTime = lastSent[category] || 0;
		const elapsed = (now - lastSentTime) / 1000; // seconds
		
		// Include message if enough time has elapsed OR if force=true (manual trigger)
		if (force || elapsed >= interval) {
			messages.push(message);
			newLastSent[category] = now;
		}
	}
	
	// Process custom categories
	const customCategories = getCustomCategories();
	for (const category of customCategories) {
		if (!category.enabled) {
			continue;
		}
		
		const categoryKey = `custom_${category.id}`;
		const lastSentTime = lastSent[categoryKey] || 0;
		const elapsed = (now - lastSentTime) / 1000;
		
		if (force || elapsed >= category.interval) {
			const prefix = category.emoji ? `${category.emoji} ` : '';
			messages.push(`${prefix}${category.message}`);
			newLastSent[categoryKey] = now;
		}
	}
	
	// Save updated last sent times
	await context.globalState.update(lastSentKey, newLastSent);
	
	// If no messages due yet, return empty (don't send)
	if (messages.length === 0) {
		return '';
	}
	
	// Combine messages with proper formatting
	let combinedMessage = messages.join('. ') + '.';
	
	// Include pending tasks if enabled
	const includeTasks = config.get<boolean>('autoContinue.includeTasks', true);
	if (includeTasks) {
		try {
			const tasks = await taskManager.getTasks(context);
			const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in-progress');
			
			if (pendingTasks.length > 0) {
				combinedMessage += `\n\n📋 Current Tasks (${pendingTasks.length}):`;
				for (const task of pendingTasks.slice(0, 5)) { // Limit to first 5 tasks
					const statusEmoji = task.status === 'in-progress' ? '🔄' : '⏳';
					combinedMessage += `\n${statusEmoji} ${task.title}`;
					if (task.description) {
						// Add abbreviated description
						const shortDesc = task.description.length > 60 
							? task.description.substring(0, 60) + '...' 
							: task.description;
						combinedMessage += ` - ${shortDesc}`;
					}
					combinedMessage += ` [id:${task.id}]`;
				}
				if (pendingTasks.length > 5) {
					combinedMessage += `\n... and ${pendingTasks.length - 5} more tasks`;
				}
			}
		} catch (error) {
			log(LogLevel.WARN, 'Failed to include tasks in auto-continue message', { error: getErrorMessage(error) });
		}
	}
	
	// Append guiding documents context if configured
	const docsContext = await guidingDocuments.getGuidingDocumentsContext();
	if (docsContext) {
		combinedMessage += docsContext;
	}
	
	return combinedMessage;
}

/**
 * Start auto-continue feature with periodic reminder checks
 * 
 * @param context - VS Code extension context for state access
 * @param getConfig - Function that returns current workspace configuration
 * @param sendToAgent - Function to send messages to Copilot Chat
 * 
 * @remarks
 * Startup behavior:
 * - Only starts if autoContinue.enabled is true in configuration
 * - Runs check every 500ms for responsive countdown
 * - Re-checks enabled state before each message send
 * - Automatically stops if disabled during execution
 * 
 * Message sending:
 * - Calls getSmartAutoContinueMessage() to determine if any categories are due
 * - Only sends if message is non-empty (categories have elapsed intervals)
 * - Logs successful sends with timestamp and content
 * - Gracefully handles errors (logs but continues running)
 * 
 * Lifecycle:
 * - Timer stored in module-level variable for stop() access
 * - Registered with context.subscriptions for automatic cleanup
 * - Can be manually stopped via stopAutoContinue()
 * 
 * @example
 * ```typescript
 * startAutoContinue(context, getConfig, sendToAgent);
 * // Auto-continue now running with 500ms check interval
 * // Will send reminders when category intervals elapse
 * ```
 */
export function startAutoContinue(
	context: vscode.ExtensionContext,
	getConfig: () => vscode.WorkspaceConfiguration,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): void {
	const config = getConfig();
	const enabled = config.get<boolean>('autoContinue.enabled', false);
	
	if (enabled) {
		// Fixed 500ms check interval for responsiveness
		const checkInterval = 500;
		
		const workspaceName = vscode.workspace.name || 'No Workspace';
		log(LogLevel.INFO, `✅ Auto-Continue enabled for window: ${workspaceName}`);
		
		autoContinueTimer = setInterval(async () => {
			try {
				// Skip if queue is actively processing or a send is in-flight
				if (isProcessingActive() || isSendingActive()) {
					return;
				}

				// Re-check if still enabled before sending
				const currentConfig = getConfig();
				const stillEnabled = currentConfig.get<boolean>('autoContinue.enabled', false);
				
				if (!stillEnabled) {
					log(LogLevel.INFO, '[Auto-Continue] Detected disabled state, stopping timer');
					if (autoContinueTimer) {
						clearInterval(autoContinueTimer);
						autoContinueTimer = undefined;
					}
					return;
				}
				
				const message = await getSmartAutoContinueMessage(context, getConfig);
				if (message) {
					log(LogLevel.INFO, '[Auto-Continue] Sending periodic reminder');
					await sendToAgent(message, { 
						source: 'auto_continue', 
						timestamp: new Date().toISOString()
					});
				}
			} catch (error) {
				log(LogLevel.ERROR, '[Auto-Continue] Failed to send message', { 
					error: getErrorMessage(error)
				});
			}
		}, checkInterval);
	} else {
		log(LogLevel.DEBUG, 'Auto-Continue is disabled');
	}
}

/**
 * Stop auto-continue timer and clean up resources
 * 
 * @remarks
 * - Clears the interval timer if active
 * - Sets timer reference to undefined
 * - Safe to call even if timer not running (idempotent)
 * - Automatically called on extension deactivation
 * 
 * @example
 * ```typescript
 * stopAutoContinue();
 * console.log('Auto-continue stopped');
 * ```
 */
export function stopAutoContinue(): void {
	if (autoContinueTimer) {
		clearInterval(autoContinueTimer);
		autoContinueTimer = undefined;
		log(LogLevel.INFO, 'Auto-Continue timer stopped');
	}
}

/**
 * Restart auto-continue with new configuration
 * 
 * @param context - VS Code extension context for state access
 * @param getConfig - Function that returns current workspace configuration
 * @param sendToAgent - Function to send messages to Copilot Chat
 * 
 * @remarks
 * - Stops existing timer if running
 * - Starts new timer with current configuration
 * - Used when configuration changes to apply new settings
 * - Internally checks if auto-continue is enabled
 * 
 * @example
 * ```typescript
 * // Called when configuration changes
 * restartAutoContinue(context, getConfig, sendToAgent);
 * ```
 */
export function restartAutoContinue(
	context: vscode.ExtensionContext,
	getConfig: () => vscode.WorkspaceConfiguration,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): void {
	// Stop existing timer if running
	stopAutoContinue();
	
	// Start auto-continue (will check if enabled internally)
	startAutoContinue(context, getConfig, sendToAgent);
}

/**
 * Check if auto-continue timer is currently active
 * 
 * @returns true if timer is running, false otherwise
 * 
 * @remarks
 * Used for debugging and status checks
 * 
 * @example
 * ```typescript
 * if (isAutoContinueActive()) {
 *   console.log('Auto-continue is running');
 * }
 * ```
 */
export function isAutoContinueActive(): boolean {
	return autoContinueTimer !== undefined;
}

/**
 * Get time until next reminder in seconds
 * 
 * @param context - VS Code extension context for state access
 * @param getConfig - Function that returns current workspace configuration
 * @returns Seconds until next reminder, or null if no categories enabled
 * 
 * @remarks
 * Calculation strategy:
 * - Iterates through all enabled categories
 * - For each category: calculates remaining = interval - elapsed
 * - Returns the shortest remaining time across all categories
 * - Returns null if no categories are enabled
 * 
 * Used for:
 * - Live countdown display in status bar
 * - User feedback about next reminder timing
 * - Debugging interval configurations
 * 
 * @example
 * ```typescript
 * const seconds = getTimeUntilNextReminder(context, getConfig);
 * if (seconds !== null) {
 *   console.log(`Next reminder in ${seconds} seconds`);
 * }
 * ```
 */
export function getTimeUntilNextReminder(
	context: vscode.ExtensionContext,
	getConfig: () => vscode.WorkspaceConfiguration
): number | null {
	const config = getConfig();
	const categories = ['tasks', 'improvements', 'coverage', 'robustness', 'cleanup', 'commits'];
	const now = Date.now();
	let shortestTime: number | null = null;
	
	// Get last sent times from global state
	const lastSentKey = 'autoContinue.lastSent';
	const lastSent = context.globalState.get<Record<string, number>>(lastSentKey, {});
	
	// Check built-in categories
	for (const category of categories) {
		const enabled = config.get<boolean>(`autoContinue.${category}.enabled`, true);
		const interval = config.get<number>(`autoContinue.${category}.interval`, 300);
		const message = config.get<string>(`autoContinue.${category}.message`, '');
		
		if (!enabled || !message) {
			continue;
		}
		
		const lastSentTime = lastSent[category] || 0;
		const elapsed = (now - lastSentTime) / 1000; // seconds
		const remaining = Math.max(0, interval - elapsed);
		
		if (shortestTime === null || remaining < shortestTime) {
			shortestTime = remaining;
		}
	}
	
	// Check custom categories
	const customCategories = getCustomCategories();
	for (const category of customCategories) {
		if (!category.enabled) {
			continue;
		}
		
		const categoryKey = `custom_${category.id}`;
		const lastSentTime = lastSent[categoryKey] || 0;
		const elapsed = (now - lastSentTime) / 1000;
		const remaining = Math.max(0, category.interval - elapsed);
		
		if (shortestTime === null || remaining < shortestTime) {
			shortestTime = remaining;
		}
	}
	
	return shortestTime;
}
