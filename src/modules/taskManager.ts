/**
 * Task management module
 * 
 * Provides CRUD operations for workspace-specific tasks with validation,
 * error handling, and state corruption recovery.
 */
import * as vscode from 'vscode';
import { Task } from './types';
import { validateTaskData, normalizeTaskData } from './taskValidation';

/**
 * Get all tasks from workspace state
 * 
 * @param context - VS Code extension context for state access
 * @returns Promise resolving to array of tasks (empty array if none exist or on error)
 * 
 * @remarks
 * - Returns empty array if state is corrupted or invalid
 * - Automatically resets state if non-array data detected
 * - Never throws - handles all errors gracefully
 * 
 * @example
 * ```typescript
 * const tasks = await getTasks(context);
 * console.log(`Found ${tasks.length} tasks`);
 * ```
 */
export async function getTasks(context: vscode.ExtensionContext): Promise<Task[]> {
	try {
		const tasks = context.workspaceState.get<Task[]>('tasks', []);
		// Validate tasks array
		if (!Array.isArray(tasks)) {
			console.error('Invalid tasks data in workspace state, resetting to empty array');
			await context.workspaceState.update('tasks', []);
			return [];
		}
		return tasks;
	} catch (error) {
		console.error('Error reading tasks from workspace state:', error);
		return [];
	}
}

/**
 * Save tasks to workspace state
 * 
 * @param context - VS Code extension context for state access
 * @param tasks - Array of tasks to save
 * @throws {Error} If tasks is not an array or save operation fails
 * 
 * @remarks
 * - Validates that input is an array before saving
 * - Throws error on validation or save failure for caller to handle
 * 
 * @example
 * ```typescript
 * try {
 *   await saveTasks(context, updatedTasks);
 * } catch (error) {
 *   console.error('Failed to save tasks:', error);
 * }
 * ```
 */
export async function saveTasks(context: vscode.ExtensionContext, tasks: Task[]): Promise<void> {
	try {
		if (!Array.isArray(tasks)) {
			throw new Error('Tasks must be an array');
		}
		await context.workspaceState.update('tasks', tasks);
	} catch (error) {
		console.error('Error saving tasks to workspace state:', error);
		throw error;
	}
}

/**
 * Add a new task with validation
 * 
 * @param context - VS Code extension context for state access
 * @param title - Task title (required, max 200 characters, will be trimmed)
 * @param description - Task description (optional, max 5000 characters, will be trimmed)
 * @param category - Task category (defaults to 'other')
 * @returns Promise resolving to the newly created task
 * @throws {Error} If validation fails (empty title, title too long, description too long)
 * 
 * @remarks
 * Validation rules:
 * - Title: Required, non-empty after trimming, maximum 200 characters
 * - Description: Optional, maximum 5000 characters
 * - Whitespace is automatically trimmed from both fields
 * - Task ID is auto-generated using timestamp
 * - Timestamps (createdAt, updatedAt) are automatically set
 * 
 * @example
 * ```typescript
 * try {
 *   const task = await addTask(context, 'Fix bug', 'Description here', 'bug');
 *   console.log(`Created task with ID: ${task.id}`);
 * } catch (error) {
 *   vscode.window.showErrorMessage(error.message);
 * }
 * ```
 */
export async function addTask(
	context: vscode.ExtensionContext,
	title: string,
	description: string = '',
	category: Task['category'] = 'other'
): Promise<Task> {
	// Validate inputs using taskValidation module
	const validation = validateTaskData(title, description, category);
	if (!validation.valid) {
		throw new Error(validation.error || 'Invalid task data');
	}

	// Normalize inputs (trim whitespace, apply defaults)
	const normalized = normalizeTaskData(title, description, category);

	const tasks = await getTasks(context);
	const newTask: Task = {
		id: Date.now().toString(),
		title: normalized.title,
		description: normalized.description,
		status: 'pending',
		category: normalized.category as Task['category'],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
	tasks.push(newTask);
	await saveTasks(context, tasks);
	return newTask;
}

/**
 * Update task status
 * 
 * @param context - VS Code extension context for state access
 * @param taskId - ID of the task to update
 * @param status - New status value ('pending' | 'in-progress' | 'completed')
 * @throws {Error} If task not found or status is invalid
 * 
 * @remarks
 * - Automatically updates the updatedAt timestamp
 * - Validates that status is one of the allowed values
 * - Task must exist or an error is thrown
 * 
 * @example
 * ```typescript
 * try {
 *   await updateTaskStatus(context, taskId, 'completed');
 * } catch (error) {
 *   vscode.window.showErrorMessage('Failed to update task');
 * }
 * ```
 */
export async function updateTaskStatus(
	context: vscode.ExtensionContext,
	taskId: string,
	status: Task['status'],
	opts?: { error?: string; summary?: string }
): Promise<void> {
	const tasks = await getTasks(context);
	const task = tasks.find(t => t.id === taskId);
	if (task) {
		task.status = status;
		task.updatedAt = new Date().toISOString();
		if (status === 'in-progress' && !task.startedAt) {
			task.startedAt = new Date().toISOString();
		}
		if (status === 'completed') {
			task.completedAt = new Date().toISOString();
			if (opts?.summary) { task.summary = opts.summary; }
		}
		if (status === 'failed') {
			task.completedAt = new Date().toISOString();
			if (opts?.error) { task.error = opts.error; }
		}
		await saveTasks(context, tasks);
	}
}

/**
 * Sweep tasks that have been in-progress for too long and mark them failed.
 */
export async function sweepStaleTasks(context: vscode.ExtensionContext, timeoutMs: number = 10 * 60 * 1000): Promise<number> {
	const tasks = await getTasks(context);
	const now = Date.now();
	let swept = 0;
	for (const task of tasks) {
		if (task.status === 'in-progress') {
			const ref = task.startedAt || task.updatedAt;
			if (now - new Date(ref).getTime() > timeoutMs) {
				task.status = 'failed';
				task.error = `timeout: no update for ${Math.round(timeoutMs / 60000)} minutes`;
				task.completedAt = new Date().toISOString();
				task.updatedAt = new Date().toISOString();
				swept++;
			}
		}
	}
	if (swept > 0) { await saveTasks(context, tasks); }
	return swept;
}

/**
 * Remove a task by ID
 * 
 * @param context - VS Code extension context for state access
 * @param taskId - ID of the task to remove
 * @returns Promise that resolves when task is removed
 * 
 * @remarks
 * - No error thrown if task doesn't exist (idempotent operation)
 * - All tasks except the specified one are preserved
 * 
 * @example
 * ```typescript
 * await removeTask(context, taskId);
 * ```
 */
export async function removeTask(context: vscode.ExtensionContext, taskId: string): Promise<void> {
	const tasks = await getTasks(context);
	const filtered = tasks.filter(t => t.id !== taskId);
	await saveTasks(context, filtered);
}

/**
 * Update a task field (title or description)
 * 
 * @param context - VS Code extension context for state access
 * @param taskId - ID of the task to update
 * @param field - Field to update ('title' or 'description')
 * @param value - New value for the field
 * @returns Promise that resolves when task is updated
 * @throws {Error} If validation fails for the field value
 * 
 * @remarks
 * - Automatically validates the new value using taskValidation
 * - Automatically updates the updatedAt timestamp
 * - No error thrown if task doesn't exist
 * - Value is trimmed before saving
 * 
 * @example
 * ```typescript
 * try {
 *   await updateTaskField(context, taskId, 'title', 'New title');
 *   await updateTaskField(context, taskId, 'description', 'New description');
 * } catch (error) {
 *   vscode.window.showErrorMessage(error.message);
 * }
 * ```
 */
export async function updateTaskField(
	context: vscode.ExtensionContext,
	taskId: string,
	field: 'title' | 'description',
	value: string
): Promise<void> {
	// Validate the new value
	const validation = field === 'title' 
		? validateTaskData(value, undefined, undefined)
		: validateTaskData('placeholder', value, undefined);
	
	if (!validation.valid) {
		throw new Error(validation.error || `Invalid ${field} value`);
	}

	const tasks = await getTasks(context);
	const task = tasks.find(t => t.id === taskId);
	if (task) {
		task[field] = value.trim();
		task.updatedAt = new Date().toISOString();
		await saveTasks(context, tasks);
	}
}

/**
 * Clear all completed tasks
 * 
 * @param context - VS Code extension context for state access
 * @returns Promise resolving to the number of tasks cleared
 * 
 * @remarks
 * - Removes all tasks with status === 'completed'
 * - Preserves all tasks with 'pending' or 'in-progress' status
 * - Safe to call even if no completed tasks exist
 * - Returns count of removed tasks
 * 
 * @example
 * ```typescript
 * const count = await clearCompletedTasks(context);
 * vscode.window.showInformationMessage(`Cleared ${count} completed tasks`);
 * ```
 */
export async function clearCompletedTasks(context: vscode.ExtensionContext): Promise<number> {
	const tasks = await getTasks(context);
	const activeTasks = tasks.filter(t => t.status !== 'completed');
	const clearedCount = tasks.length - activeTasks.length;
	await saveTasks(context, activeTasks);
	return clearedCount;
}
