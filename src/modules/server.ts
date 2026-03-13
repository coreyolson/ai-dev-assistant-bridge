/**
 * HTTP Server module for AI Dev Assistant Bridge
 * 
 * Provides REST API endpoints for external communication with the extension.
 * Handles health checks, feedback submission, task management, and port queries.
 * 
 * Security features:
 * - Port validation (1024-65535 range)
 * - Request size limiting (1MB max)
 * - Request timeout (30 seconds)
 * - CORS headers for cross-origin requests
 */
import * as vscode from 'vscode';
import * as http from 'http';
import { log, getErrorMessage } from './logging';
import { LogLevel } from './types';
import * as taskManager from './taskManager';
import * as aiQueue from './aiQueue';
import * as responseQueue from './responseQueue';
import * as webhooks from './webhooks';
import { validatePort } from './numberValidation';

let server: http.Server | undefined;

// Constants for security
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB max request body
const REQUEST_TIMEOUT = 30000; // 30 seconds

/**
 * Validate port number is in safe range
 * 
 * @param port - Port number to validate
 * @returns true if port is valid (1024-65535), false otherwise
 * 
 * @remarks
 * - Requires integer value
 * - Excludes privileged ports (0-1023)
 * - Maximum port is 65535 (TCP/IP limit)
 * 
 * @deprecated Use validatePort from numberValidation module instead
 */
function isValidPort(port: number): boolean {
	const result = validatePort(port);
	return result.valid;
}

/**
 * Start the HTTP server on specified port
 * 
 * @param context - VS Code extension context for state access
 * @param port - Port number to listen on (must be 1024-65535)
 * @param sendToAgent - Function to send messages to Copilot Chat
 * @returns HTTP server instance
 * @throws {Error} If port is invalid (outside 1024-65535 range)
 * 
 * @remarks
 * Security features:
 * - Validates port number before starting
 * - Sets 30-second timeout on all requests
 * - Limits request body size to 1MB
 * - Enables CORS for cross-origin requests
 * - Handles OPTIONS preflight requests
 * 
 * Error handling:
 * - EADDRINUSE: Port already in use (shown to user)
 * - Request timeout: Returns 408 status
 * - Handler errors: Returns 500 status
 * 
 * @example
 * ```typescript
 * try {
 *   const server = startServer(context, 3737, sendToAgent);
 *   console.log('Server started successfully');
 * } catch (error) {
 *   vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
 * }
 * ```
 */
export function startServer(
	context: vscode.ExtensionContext,
	port: number,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): http.Server {
	// Validate port number
	if (!isValidPort(port)) {
		const error = `Invalid port number: ${port}. Must be between 1024 and 65535.`;
		log(LogLevel.ERROR, error);
		throw new Error(error);
	}

	server = http.createServer(async (req, res) => {
		// Set timeout for request
		req.setTimeout(REQUEST_TIMEOUT, () => {
			log(LogLevel.WARN, 'Request timeout', { url: req.url, method: req.method });
			if (!res.headersSent) {
				res.writeHead(408, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Request timeout' }));
			}
		});

		// Set CORS headers
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		// Handle OPTIONS preflight
		if (req.method === 'OPTIONS') {
			res.writeHead(200);
			res.end();
			return;
		}

		try {
			await handleRequest(req, res, context, port, sendToAgent);
		} catch (error) {
			log(LogLevel.ERROR, 'Request handler error', getErrorMessage(error));
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Internal server error' }));
			}
		}
	});

	// Start server with error handling
	server.listen(port, () => {
		log(LogLevel.INFO, `✅ Server listening on port ${port}`);
	});

	// Handle server errors
	server.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code === 'EADDRINUSE') {
			log(LogLevel.ERROR, `Port ${port} is already in use. Please change the port in settings.`);
		} else {
			log(LogLevel.ERROR, 'Server error occurred', { error: error.message, code: error.code });
		}
	});

	// Clean up server on deactivation
	context.subscriptions.push({
		dispose: () => {
			stopServer();
		}
	});

	// Wire up linked task auto-completion: when a queue item with a linkedTaskId completes, mark the task done
	aiQueue.setLinkedTaskCallback(async (taskId: string) => {
		await taskManager.updateTaskStatus(context, taskId, 'completed');
		webhooks.fireWebhookEvent('task.completed', { taskId });
	});

	// Periodic sweep: mark stale in-progress tasks as failed (every 2 minutes)
	const sweepInterval = setInterval(async () => {
		try {
			const swept = await taskManager.sweepStaleTasks(context);
			if (swept > 0) {
				log(LogLevel.WARN, `Task sweep: marked ${swept} stale task(s) as failed`);
			}
		} catch { /* best-effort */ }
	}, 2 * 60 * 1000);
	context.subscriptions.push({ dispose: () => clearInterval(sweepInterval) });

	return server;
}

/**
 * Stop the HTTP server and clean up resources
 * 
 * @remarks
 * - Closes all active connections
 * - Safe to call even if server is not running
 * - Idempotent operation (can be called multiple times)
 * - Automatically called on extension deactivation
 * 
 * @example
 * ```typescript
 * stopServer(); // Gracefully shutdown server
 * ```
 */
export function stopServer(): void {
	if (server) {
		log(LogLevel.INFO, 'Closing server');
		server.close();
		server = undefined;
	}
}

/**
 * Get the current server instance
 * 
 * @returns The active HTTP server instance, or undefined if not running
 * 
 * @remarks
 * Used by commands to check server status without direct access to module internals
 * 
 * @example
 * ```typescript
 * const server = getServer();
 * if (server && server.listening) {
 *   console.log('Server is running');
 * }
 * ```
 */
export function getServer(): http.Server | undefined {
	return server;
}

/**
 * Handle incoming HTTP requests and route to appropriate endpoint
 * 
 * @param req - HTTP request object
 * @param res - HTTP response object
 * @param context - VS Code extension context for state access
 * @param port - Current server port number
 * @param sendToAgent - Function to send messages to Copilot Chat
 * 
 * @remarks
 * Supported endpoints:
 * - GET /health: Health check (returns OK)
 * - GET /port: Get current port number
 * - POST /feedback: Submit feedback message
 * - GET /tasks: List all tasks
 * - POST /tasks: Create new task
 * - PUT /tasks/:id/status: Update task status
/**
 * Handle incoming HTTP requests and route to appropriate endpoint
 * 
 * @param req - HTTP request object
 * @param res - HTTP response object
 * @param context - VS Code extension context for state access
 * @param port - Current server port number
 * @param sendToAgent - Function to send messages to Copilot Chat
 * 
 * @remarks
 * Supported endpoints:
 * - GET /health: Health check (returns OK)
 * - GET /port: Get current port number
 * - POST /feedback: Submit feedback message
 * - GET /tasks: List all tasks
 * - POST /tasks: Create new task
 * - PUT /tasks/:id/status: Update task status
 * - DELETE /tasks/:id: Delete task
 * - POST /responses: Submit response for a completed task
 * - GET /responses: Get pending responses (marks as read)
 * - GET /responses/stats: Response queue statistics
 * 
 * Security:
 * - Enforces 1MB max request body size
 * - Validates JSON payloads
 * - Returns 400 for malformed requests
 * - Returns 404 for unknown endpoints
 * - Returns 405 for unsupported methods
 */
async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	context: vscode.ExtensionContext,
	port: number,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): Promise<void> {
	const url = req.url || '/';
	const method = req.method || 'GET';

	log(LogLevel.DEBUG, `${method} ${url}`);

	// Route handling
	if (url === '/help' || url === '/') {
		handleHelp(res, port);
	} else if (url === '/tasks' && method === 'GET') {
		await handleGetTasks(res, context);
	} else if (url === '/tasks' && method === 'POST') {
		await handleCreateTask(req, res, context);
	} else if (url === '/tasks/status' && method === 'GET') {
		await handleQueueStatus(res, context);
	} else if (url.startsWith('/tasks/status/') && method === 'GET') {
		await handleTaskStatusById(res, context, url);
	} else if (url.startsWith('/tasks/') && method === 'PUT') {
		await handleUpdateTask(req, res, context, url);
	} else if (url.startsWith('/tasks/') && method === 'DELETE') {
		await handleDeleteTask(res, context, url);
	} else if (url === '/feedback' && method === 'POST') {
		await handleFeedback(req, res, sendToAgent);
	} else if (url === '/restart-app' || url.startsWith('/restart-app?')) {
		await handleRestartApp(req, res);
	} else if (url === '/responses' && method === 'POST') {
		await handlePostResponse(req, res);
	} else if ((url === '/responses' || url.startsWith('/responses?')) && method === 'GET') {
		handleGetResponses(req, res);
	} else if (url === '/responses/stats' && method === 'GET') {
		handleResponseStats(res);
	} else if (url === '/ai/queue' && method === 'GET') {
		handleGetQueue(res);
	} else if (url === '/ai/queue' && method === 'POST') {
		await handleEnqueueInstruction(req, res, context);
	} else if (url === '/ai/queue/process' && method === 'POST') {
		await handleProcessQueue(res, sendToAgent);
	} else if (url === '/ai/queue/stats' && method === 'GET') {
		handleGetQueueStats(res);
	} else if (url === '/ai/queue/pending' && method === 'GET') {
		handleGetPendingQueue(res);
	} else if (url === '/ai/queue/stalled' && method === 'GET') {
		handleGetStalledQueue(res);
	} else if (url.match(/^\/ai\/queue\/[^/]+\/heartbeat$/) && method === 'POST') {
		handleQueueHeartbeat(res, url);
	} else if (url.startsWith('/ai/queue/') && method === 'DELETE') {
		handleDeleteFromQueue(res, url);
	} else if (url === '/ai/queue/clear' && method === 'POST') {
		handleClearQueue(res);
	} else if (url === '/webhooks' && method === 'GET') {
		handleListWebhooks(res);
	} else if (url === '/webhooks/register' && method === 'POST') {
		await handleRegisterWebhook(req, res);
	} else if (url === '/webhooks/unregister' && method === 'POST') {
		await handleUnregisterWebhook(req, res);
	} else {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found', message: `Unknown endpoint: ${method} ${url}` }));
	}
}

/**
 * Handle GET /help - API documentation
 */
function handleHelp(res: http.ServerResponse, port: number): void {
	const helpText = `
AI Dev Assistant Bridge - API Documentation
=======================================

Base URL: http://localhost:${port}

Endpoints:
----------

GET /
GET /help
    Returns this API documentation

GET /tasks
    List all workspace tasks
    Response: Array of task objects

POST /tasks
    Create a new task
    Body: {
        "title": "Task title",
        "description": "Optional description",
        "category": "bug|feature|improvement|documentation|testing|other"
    }
    Response: Created task object

PUT /tasks/:id
    Update a task status
    Body: {
        "status": "pending|in-progress|completed|failed",
        "error": "optional error message (for failed)",
        "summary": "optional summary (for completed)"
    }
    Response: { success: true }

DELETE /tasks/:id
    Delete a task
    Response: { success: true }

GET /tasks/status
    Consolidated queue status — pending, in-progress, completed (24h), failed
    Auto-sweeps stale in-progress tasks (>10min) to failed
    Response: { pending: {...}, inProgress: {...}, completed: {...}, failed: {...} }

GET /tasks/status/:id
    Single task lookup with computed age/duration
    Response: Task object with ageSeconds, durationSeconds (if in-progress)

POST /feedback
    Send feedback to AI agent
    Body: {
        "message": "Feedback message",
        "context": { ... optional context ... }
    }
    Response: { success: true, message: "Feedback sent to AI Agent" }

POST /restart-app?delay=30
    Restart the Electron app (if applicable)
    Query params: delay (seconds, default 30)
    Response: { success: true, message: "App restart initiated" }

GET /ai/queue
    Get all instructions in the AI communication queue
    Response: { queue: [...], count: number }

POST /ai/queue
    Add instruction to the AI communication queue
    Body: {
        "instruction": "Instruction text for AI",
        "source": "external-app (optional)",
        "priority": "low|normal|high|urgent (optional, default: normal)",
        "metadata": { ... optional context ... }
    }
    Response: { success: true, queueItem: {...} }

POST /ai/queue/process
    Process the next pending instruction in queue
    Response: { success: true|false, message: string }

GET /ai/queue/stats
    Get queue statistics
    Response: { total, pending, processing, completed, failed, autoProcessEnabled }

DELETE /ai/queue/:id
    Remove instruction from queue by ID
    Response: { success: true, message: "Instruction removed" }

POST /ai/queue/clear
    Clear all processed (completed and failed) instructions
    Response: { success: true, message: "Cleared N instructions" }

POST /responses
    Submit a structured response for a completed task
    Body: {
        "taskId": "task-id",
        "status": "completed|partial|failed|blocked",
        "summary": "What was done",
        "findings": ["key finding 1", "key finding 2"],
        "blockers": ["blocker if any"],
        "nextQuestions": ["question back to submitter"]
    }
    Response: { success: true, response: {...} }

GET /responses
    Get pending (unread) responses. Marks returned responses as read.
    Query params:
      ?all=true    - Return all responses (not just unread)
      ?taskId=ID   - Filter by task ID
    Response: { responses: [...], count: number }

GET /responses/stats
    Get response queue statistics
    Response: { total, pending, read }

Examples:
---------

# List all tasks
curl http://localhost:${port}/tasks

# Create a task
curl -X POST http://localhost:${port}/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Fix bug", "category": "bug"}'

# Update task status
curl -X PUT http://localhost:${port}/tasks/12345 \\
  -H "Content-Type: application/json" \\
  -d '{"status": "in-progress"}'

# Send feedback
curl -X POST http://localhost:${port}/feedback \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Please review this code"}'

# Enqueue AI instruction
curl -X POST http://localhost:${port}/ai/queue \\
  -H "Content-Type: application/json" \\
  -d '{"instruction": "Analyze the codebase for performance issues", "priority": "high"}'

# Process queue
curl -X POST http://localhost:${port}/ai/queue/process

# Get queue stats
curl http://localhost:${port}/ai/queue/stats
`;

	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end(helpText);
}

/**
 * Handle GET /tasks - List all tasks
 */
async function handleGetTasks(res: http.ServerResponse, context: vscode.ExtensionContext): Promise<void> {
	try {
		const tasks = await taskManager.getTasks(context);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(tasks, null, 2));
	} catch (error) {
		log(LogLevel.ERROR, 'Failed to get tasks', getErrorMessage(error));
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to retrieve tasks' }));
	}
}

/**
 * Handle POST /tasks - Create a task
 */
async function handleCreateTask(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	context: vscode.ExtensionContext
): Promise<void> {
	try {
		const body = await readRequestBody(req);
		const data = JSON.parse(body);
		
		// Validate required fields
		if (!data.title || typeof data.title !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid "title" field (must be non-empty string)' }));
			return;
		}

		// Validate title length
		const title = data.title.trim();
		if (title.length === 0) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Title cannot be empty' }));
			return;
		}
		if (title.length > 200) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Title too long (max 200 characters)' }));
			return;
		}

		// Validate optional fields
		const description = data.description ? String(data.description).trim() : '';
		if (description.length > 5000) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Description too long (max 5000 characters)' }));
			return;
		}

		const validCategories = ['feature', 'bug', 'improvement', 'other'];
		const category = validCategories.includes(data.category) ? data.category : 'other';

		const task = await taskManager.addTask(context, title, description, category);
		
		log(LogLevel.INFO, 'Task created via API', { taskId: task.id, title: task.title });
		
		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(task, null, 2));
	} catch (error) {
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else if (error instanceof Error && error.message.includes('too large')) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: error.message }));
		} else {
			log(LogLevel.ERROR, 'Failed to create task', getErrorMessage(error));
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to create task' }));
		}
	}
}

/**
 * Handle PUT /tasks/:id - Update task status
 */
async function handleUpdateTask(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	context: vscode.ExtensionContext,
	url: string
): Promise<void> {
	const taskId = url.split('/')[2];
	const body = await readRequestBody(req);
	
	try {
		const data = JSON.parse(body);
		
		if (!data.status || !['pending', 'in-progress', 'completed', 'failed'].includes(data.status)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ 
				error: 'Invalid or missing "status" field', 
				valid: ['pending', 'in-progress', 'completed', 'failed'] 
			}));
			return;
		}

		await taskManager.updateTaskStatus(context, taskId, data.status, {
			error: data.error,
			summary: data.summary,
		});
		
		log(LogLevel.INFO, 'Task updated via API', { taskId, status: data.status });
		
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, taskId, status: data.status }));
	} catch (error) {
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else {
			log(LogLevel.ERROR, 'Failed to update task', getErrorMessage(error));
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to update task' }));
		}
	}
}

/**
 * Handle DELETE /tasks/:id - Delete a task
 */
async function handleDeleteTask(
	res: http.ServerResponse,
	context: vscode.ExtensionContext,
	url: string
): Promise<void> {
	const taskId = url.split('/')[2];
	
	try {
		await taskManager.removeTask(context, taskId);
		
		log(LogLevel.INFO, 'Task deleted via API', { taskId });
		
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, taskId }));
	} catch (error) {
		log(LogLevel.ERROR, 'Failed to delete task', getErrorMessage(error));
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to delete task' }));
	}
}

/**
 * Handle GET /tasks/status - Consolidated queue status view
 */
async function handleQueueStatus(res: http.ServerResponse, context: vscode.ExtensionContext): Promise<void> {
	try {
		// Sweep stale tasks before reporting
		const swept = await taskManager.sweepStaleTasks(context);
		if (swept > 0) {
			log(LogLevel.WARN, `Swept ${swept} stale task(s) to failed`);
		}

		const tasks = await taskManager.getTasks(context);
		const now = Date.now();
		const h24 = 24 * 60 * 60 * 1000;

		const pending = tasks
			.filter(t => t.status === 'pending')
			.map(t => ({
				id: t.id,
				title: t.title,
				category: t.category,
				priority: (t as unknown as Record<string, unknown>).priority ?? 'normal',
				ageSeconds: Math.round((now - new Date(t.createdAt).getTime()) / 1000),
				createdAt: t.createdAt,
			}));

		const inProgress = tasks
			.filter(t => t.status === 'in-progress')
			.map(t => ({
				id: t.id,
				title: t.title,
				category: t.category,
				startedAt: t.startedAt ?? t.updatedAt,
				durationSeconds: Math.round((now - new Date(t.startedAt ?? t.updatedAt).getTime()) / 1000),
			}));

		const completed = tasks
			.filter(t => t.status === 'completed' && t.completedAt && now - new Date(t.completedAt).getTime() < h24)
			.map(t => ({
				id: t.id,
				title: t.title,
				completedAt: t.completedAt,
				summary: t.summary,
			}));

		const failed = tasks
			.filter(t => t.status === 'failed')
			.map(t => ({
				id: t.id,
				title: t.title,
				error: t.error,
				completedAt: t.completedAt,
			}));

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			pending: { count: pending.length, tasks: pending },
			inProgress: { count: inProgress.length, tasks: inProgress },
			completed: { count: completed.length, tasks: completed },
			failed: { count: failed.length, tasks: failed },
			total: tasks.length,
			swept,
		}, null, 2));
	} catch (error) {
		log(LogLevel.ERROR, 'Failed to get queue status', getErrorMessage(error));
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to get queue status' }));
	}
}

/**
 * Handle GET /tasks/status/:taskId - Single task lookup
 */
async function handleTaskStatusById(res: http.ServerResponse, context: vscode.ExtensionContext, url: string): Promise<void> {
	const taskId = url.split('/')[3];
	try {
		const tasks = await taskManager.getTasks(context);
		const task = tasks.find(t => t.id === taskId);
		if (!task) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found', taskId }));
			return;
		}
		const now = Date.now();
		const enriched = {
			...task,
			ageSeconds: Math.round((now - new Date(task.createdAt).getTime()) / 1000),
			...(task.status === 'in-progress' ? {
				durationSeconds: Math.round((now - new Date(task.startedAt ?? task.updatedAt).getTime()) / 1000),
			} : {}),
		};
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(enriched, null, 2));
	} catch (error) {
		log(LogLevel.ERROR, 'Failed to get task status', getErrorMessage(error));
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to get task status' }));
	}
}

/**
 * Handle POST /feedback - Send feedback to AI agent
 */
async function handleFeedback(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): Promise<void> {
	const body = await readRequestBody(req, 1024 * 1024); // 1MB limit
	
	try {
		const feedback = JSON.parse(body);
		
		if (!feedback || typeof feedback !== 'object') {
			throw new Error('Invalid feedback structure: must be an object');
		}
		
		if (!feedback.message || typeof feedback.message !== 'string') {
			throw new Error('Invalid feedback: missing or invalid "message" field');
		}
		
		const sanitizedMessage = feedback.message.trim();
		if (sanitizedMessage.length === 0) {
			throw new Error('Invalid feedback: message cannot be empty');
		}
		
		if (sanitizedMessage.length > 50000) {
			throw new Error('Invalid feedback: message too long (max 50000 characters)');
		}
		
		log(LogLevel.INFO, 'Received feedback', { 
			messageLength: sanitizedMessage.length,
			hasContext: !!feedback.context 
		});

		const success = await sendToAgent(sanitizedMessage, feedback.context);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ 
			success, 
			message: success ? 'Feedback sent to AI Agent' : 'Failed to send to AI Agent' 
		}));

	} catch (error) {
		const errorMessage = getErrorMessage(error);
		log(LogLevel.ERROR, 'Error processing feedback', { error: errorMessage });
		
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: errorMessage }));
		}
	}
}

/**
 * Handle POST /restart-app - Restart Electron app
 */
async function handleRestartApp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const urlParts = (req.url || '').split('?');
	const queryParams = new URLSearchParams(urlParts[1] || '');
	const delaySeconds = parseInt(queryParams.get('delay') || '30', 10);
	
	log(LogLevel.INFO, `Received restart request for Electron app (delay: ${delaySeconds}s)`);
	
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ 
		success: true, 
		message: `App restart initiated (will restart in ${delaySeconds}s)`,
		delay: delaySeconds
	}));
	
	// Restart asynchronously (don't block response)
	setTimeout(async () => {
		try {
			const { exec } = require('child_process');
			const { promisify } = require('util');
			const execAsync = promisify(exec);
			
			log(LogLevel.INFO, 'Killing Electron process...');
			try {
				await execAsync('pkill -f "electron.*Code/AI"');
			} catch (e) {
				log(LogLevel.INFO, 'Kill command completed (process may not have been running)');
			}
			
			log(LogLevel.INFO, `Waiting ${delaySeconds} seconds before restart...`);
			await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
			
			const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspacePath && workspacePath.includes('/AI')) {
				log(LogLevel.INFO, `Restarting Electron app in: ${workspacePath}`);
				exec(`cd "${workspacePath}" && npm run dev > /dev/null 2>&1 &`);
				log(LogLevel.INFO, 'Electron app restart command sent');
			} else {
				log(LogLevel.WARN, `Could not find workspace path: ${workspacePath}`);
			}
		} catch (error) {
			log(LogLevel.ERROR, 'Restart error', getErrorMessage(error));
		}
	}, 100);
}

/**
 * Read request body with optional size limit
 */
async function readRequestBody(req: http.IncomingMessage, maxSize: number = 10 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = '';
		let bodySize = 0;
		
		req.on('data', chunk => {
			bodySize += chunk.length;
			if (bodySize > maxSize) {
				reject(new Error(`Request body too large (max ${maxSize} bytes)`));
				req.destroy();
				return;
			}
			body += chunk.toString();
		});

		req.on('end', () => {
			resolve(body);
		});

		req.on('error', (error) => {
			reject(error);
		});
	});
}

/**
 * Handle GET /ai/queue - Get all instructions in queue
 */
function handleGetQueue(res: http.ServerResponse): void {
	try {
		const queue = aiQueue.getQueue();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ queue, count: queue.length }));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle POST /ai/queue - Enqueue a new instruction
 * Accepts optional `title` and `category` to create a linked persistent task.
 * One dispatch = one queue item + one linked task (if title provided).
 */
async function handleEnqueueInstruction(req: http.IncomingMessage, res: http.ServerResponse, context: vscode.ExtensionContext): Promise<void> {
	try {
		const body = await readRequestBody(req);
		const data = JSON.parse(body);
		
		if (!data.instruction || typeof data.instruction !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Bad request', message: 'Missing or invalid instruction field' }));
			return;
		}
		
		const source = data.source || 'external-api';
		const priority = data.priority || 'normal';
		const metadata = data.metadata || {};

		// If title provided, create a linked persistent task first
		let linkedTaskId: string | undefined;
		if (data.title && typeof data.title === 'string') {
			const category = ['feature', 'bug', 'improvement', 'other'].includes(data.category) ? data.category : 'improvement';
			const task = await taskManager.addTask(context, data.title.trim(), data.instruction, category);
			linkedTaskId = task.id;
			log(LogLevel.INFO, `Created linked task ${task.id} for queue instruction`, { title: data.title });
		}
		
		const queueItem = aiQueue.enqueueInstruction(data.instruction, source, priority, metadata, linkedTaskId);

		if (!queueItem) {
			// Dedup rejected — clean up the linked task if we created one
			if (linkedTaskId) {
				try { await taskManager.removeTask(context, linkedTaskId); } catch { /* ignore */ }
			}
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: false,
				message: 'Duplicate instruction rejected (same instruction within 60s window)',
				duplicate: true
			}));
			return;
		}
		
		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ 
			success: true, 
			message: 'Instruction enqueued',
			queueItem,
			linkedTaskId
		}));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle POST /ai/queue/process - Process next instruction in queue
 */
async function handleProcessQueue(
	res: http.ServerResponse,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): Promise<void> {
	try {
		const processed = await aiQueue.processNextInstruction(sendToAgent);
		
		if (processed) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ 
				success: true, 
				message: 'Instruction processed' 
			}));
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ 
				success: false, 
				message: 'No pending instructions in queue' 
			}));
		}
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle GET /ai/queue/stats - Get queue statistics
 */
function handleGetQueueStats(res: http.ServerResponse): void {
	try {
		const stats = aiQueue.getQueueStats();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(stats));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle DELETE /ai/queue/:id - Remove instruction from queue
 */
function handleDeleteFromQueue(res: http.ServerResponse, url: string): void {
	try {
		const id = url.split('/').pop();
		if (!id) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Bad request', message: 'Missing instruction ID' }));
			return;
		}
		
		const removed = aiQueue.removeInstruction(id);
		
		if (removed) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, message: 'Instruction removed' }));
		} else {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found', message: 'Instruction ID not found in queue' }));
		}
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle POST /responses - Submit a response for a completed task
 */
async function handlePostResponse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const body = await readRequestBody(req);
		const data = JSON.parse(body);

		if (!data.taskId || typeof data.taskId !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid "taskId" field' }));
			return;
		}

		if (!data.status || !['completed', 'partial', 'failed', 'blocked', 'in-progress'].includes(data.status)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid or missing "status" field', valid: ['completed', 'partial', 'failed', 'blocked', 'in-progress'] }));
			return;
		}

		if (!data.summary || typeof data.summary !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid "summary" field' }));
			return;
		}

		const response = responseQueue.addResponse(
			data.taskId,
			data.status,
			data.summary,
			Array.isArray(data.findings) ? data.findings : undefined,
			Array.isArray(data.blockers) ? data.blockers : undefined,
			Array.isArray(data.nextQuestions) ? data.nextQuestions : undefined
		);

		// Fire webhook for response creation
		webhooks.fireWebhookEvent('response.created', { response });

		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, response }));
	} catch (error) {
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else {
			log(LogLevel.ERROR, 'Failed to create response', getErrorMessage(error));
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to create response' }));
		}
	}
}

/**
 * Handle GET /responses - Get pending responses (marks them as read)
 */
function handleGetResponses(req: http.IncomingMessage, res: http.ServerResponse): void {
	try {
		const url = req.url || '/responses';
		const queryIndex = url.indexOf('?');
		const params = queryIndex >= 0 ? new URLSearchParams(url.slice(queryIndex)) : new URLSearchParams();
		const all = params.get('all') === 'true';
		const taskId = params.get('taskId') || undefined;

		let responses;
		if (all || taskId) {
			responses = responseQueue.getAllResponses(taskId);
		} else {
			responses = responseQueue.getPendingResponses();
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ responses, count: responses.length }));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle GET /responses/stats - Response queue statistics
 */
function handleResponseStats(res: http.ServerResponse): void {
	try {
		const stats = responseQueue.getResponseStats();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(stats));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle POST /ai/queue/clear - Clear all processed instructions
 */
function handleClearQueue(res: http.ServerResponse): void {
	try {
		const cleared = aiQueue.clearProcessed();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ 
			success: true, 
			message: `Cleared ${cleared} processed instructions` 
		}));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle GET /ai/queue/pending — tasks not yet finalized
 */
function handleGetPendingQueue(res: http.ServerResponse): void {
	try {
		const pending = aiQueue.getPendingInstructions();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ instructions: pending, count: pending.length }));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle GET /ai/queue/stalled — tasks with expired heartbeat
 */
function handleGetStalledQueue(res: http.ServerResponse): void {
	try {
		const stalled = aiQueue.getStalledInstructions();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ instructions: stalled, count: stalled.length }));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

/**
 * Handle POST /ai/queue/:id/heartbeat — keepalive for processing tasks
 */
function handleQueueHeartbeat(res: http.ServerResponse, url: string): void {
	try {
		const parts = url.split('/');
		const id = parts[3]; // /ai/queue/:id/heartbeat
		if (!id) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing instruction ID' }));
			return;
		}
		const success = aiQueue.recordHeartbeat(id);
		if (success) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, timestamp: new Date().toISOString() }));
		} else {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Instruction not found or not processing' }));
		}
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error', message: getErrorMessage(error) }));
	}
}

// ─── Webhook Handlers ───────────────────────────────────────────────────────

function handleListWebhooks(res: http.ServerResponse): void {
	const list = webhooks.listWebhooks();
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ webhooks: list, count: list.length }));
}

async function handleRegisterWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const body = await readRequestBody(req);
		const data = JSON.parse(body);

		if (!data.url || typeof data.url !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing or invalid "url" field' }));
			return;
		}

		// Validate URL format
		try {
			const parsed = new URL(data.url);
			if (!['http:', 'https:'].includes(parsed.protocol)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'URL must use http or https protocol' }));
				return;
			}
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid URL format' }));
			return;
		}

		const events = Array.isArray(data.events) ? data.events : ['*'];
		const registration = webhooks.registerWebhook(data.url, events);

		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true, webhook: registration }));
	} catch (error) {
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to register webhook' }));
		}
	}
}

async function handleUnregisterWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const body = await readRequestBody(req);
		const data = JSON.parse(body);

		const key = data.url || data.id;
		if (!key || typeof key !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Provide "url" or "id" to unregister' }));
			return;
		}

		const removed = webhooks.unregisterWebhook(key);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: removed }));
	} catch (error) {
		if (error instanceof SyntaxError) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON format' }));
		} else {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to unregister webhook' }));
		}
	}
}
