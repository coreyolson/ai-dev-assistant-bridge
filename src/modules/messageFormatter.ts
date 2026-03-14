/**
 * Message Formatting Module
 * 
 * Pure functions for formatting feedback messages and context.
 * No VS Code API dependencies - fully unit testable.
 */

/**
 * Context data structure for feedback messages
 */
export interface FeedbackContext {
	source: string;
	timestamp: string;
	[key: string]: unknown;
}

/**
 * Format a feedback message with optional context for AI processing
 * 
 * Creates a structured markdown message that includes:
 * - User feedback text
 * - Optional context data (excluding source/timestamp if no other fields)
 * - Standard instructions for AI processing
 * 
 * @param feedbackMessage - The user's feedback text
 * @param appContext - Optional context object with source, timestamp, and custom fields
 * @returns Formatted markdown string ready for AI consumption
 * 
 * @example
 * ```typescript
 * // Minimal context (only source/timestamp)
 * const msg1 = formatFeedbackMessage('Bug in login', {
 *   source: 'http_api',
 *   timestamp: '2024-01-01T00:00:00Z'
 * });
 * // Result: No context section included
 * 
 * // Rich context (includes custom fields)
 * const msg2 = formatFeedbackMessage('Feature request', {
 *   source: 'http_api',
 *   timestamp: '2024-01-01T00:00:00Z',
 *   userId: 123,
 *   page: '/dashboard'
 * });
 * // Result: Context section with userId and page fields
 * ```
 */
export function formatFeedbackMessage(feedbackMessage: string, appContext?: unknown): string {
	const context = resolveContext(appContext);

	// Ultra-concise format to minimize token usage
	let fullMessage = `**AI Dev Instructions:**\n${feedbackMessage}\n\n`;

	const filteredContext = extractContextDetails(context);
	if (filteredContext) {
		fullMessage += `**Context:**\n\`\`\`json\n${JSON.stringify(filteredContext, null, 2)}\n\`\`\`\n\n`;
	}

	// Extract IDs from context for pre-filled curl commands
	const ctx = context as Record<string, unknown>;
	const queueId = typeof ctx.queueId === 'string' ? ctx.queueId : '<ID>';
	const taskId = typeof ctx.linkedTaskId === 'string' ? ctx.linkedTaskId : queueId;

	fullMessage += `**Instructions:**\n`;
	fullMessage += `Analyze feedback, take appropriate action:\n`;
	fullMessage += `• If a bug → find and fix root cause\n`;
	fullMessage += `• If a feature → draft implementation plan\n`;
	fullMessage += `• Apply and commit changes\n`;
	fullMessage += `• Use the **report_progress** tool during long tasks to provide visibility (taskId: \`${queueId}\`)\n`;
	fullMessage += `• When done, use the **report_completion** tool to report results back (taskId: \`${queueId}\`, status, summary, findings, blockers, nextQuestions)\n`;

	return fullMessage;
}

/**
 * Check if context has meaningful data beyond source and timestamp
 * 
 * @param context - Context object to check
 * @returns True if context has custom fields, false otherwise
 */
export function hasRichContext(context: unknown): boolean {
	if (!context || typeof context !== 'object') {
		return false;
	}
	
	return extractContextDetails(context as FeedbackContext) !== undefined;
}

function resolveContext(appContext: unknown): FeedbackContext {
	if (!appContext || typeof appContext !== 'object') {
		return {
			source: 'unknown',
			timestamp: new Date().toISOString()
		};
	}

	return appContext as FeedbackContext;
}

function extractContextDetails(context: FeedbackContext): Record<string, unknown> | undefined {
	const filtered: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(context)) {
		if (key === 'source' || key === 'timestamp') {
			continue;
		}

		filtered[key] = value;
	}

	return Object.keys(filtered).length > 0 ? filtered : undefined;
}
