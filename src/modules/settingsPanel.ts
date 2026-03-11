/**
 * Settings panel module - WebView UI for extension settings
 */
import * as vscode from 'vscode';
import { Task, LogLevel } from './types';
import { log, getErrorMessage } from './logging';
import * as taskManager from './taskManager';
import * as guidingDocuments from './guidingDocuments';
import { autoInjectScript } from './autoApproval';
import * as customCategories from './customCategories';

let settingsPanel: vscode.WebviewPanel | undefined;

/**
 * Show or reveal the settings panel
 */
export async function showSettingsPanel(
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration,
	updateConfig: (key: string, value: unknown) => Promise<void>,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>,
	getSmartAutoContinueMessage: (context: vscode.ExtensionContext, force: boolean) => Promise<string | null>
): Promise<void> {
	// If panel already exists, just reveal it
	if (settingsPanel) {
		settingsPanel.reveal(vscode.ViewColumn.One);
		// Refresh with current config and tasks
		const tasks = await taskManager.getTasks(context);
		const docs = guidingDocuments.getGuidingDocuments();
		settingsPanel.webview.html = await getSettingsHtml(getConfig(), currentPort, tasks, docs);
		return;
	}
	
	const panel = vscode.window.createWebviewPanel(
		'aiDevAssistantBridgeSettings',
		'AI Dev Assistant Bridge Settings',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);
	
	// Store reference globally
	settingsPanel = panel;
	
	// Clear reference when panel is disposed
	panel.onDidDispose(() => {
		settingsPanel = undefined;
	}, null, context.subscriptions);

	const config = getConfig();
	const tasks = await taskManager.getTasks(context);
	const docs = guidingDocuments.getGuidingDocuments();
	
	panel.webview.html = await getSettingsHtml(config, currentPort, tasks, docs);
	
	// Handle messages from webview
	panel.webview.onDidReceiveMessage(
		async message => {
			await handleWebviewMessage(
				message,
				panel,
				context,
				currentPort,
				getConfig,
				updateConfig,
				sendToAgent,
				getSmartAutoContinueMessage
			);
		},
		undefined,
		context.subscriptions
	);
}

/**
 * Handle messages from the webview
 */
async function handleWebviewMessage(
	message: any,
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration,
	updateConfig: (key: string, value: unknown) => Promise<void>,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>,
	getSmartAutoContinueMessage: (context: vscode.ExtensionContext, force: boolean) => Promise<string | null>
): Promise<void> {
	switch (message.command) {
		case 'updateSetting':
			await updateConfig(message.key, message.value);
			log(LogLevel.INFO, `Setting updated: ${message.key} = ${message.value}`);
			break;
			
		case 'reload':
			const reloadTasks = await taskManager.getTasks(context);
			const reloadDocs = guidingDocuments.getGuidingDocuments();
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, reloadTasks, reloadDocs);
			break;
			
		case 'runNow':
			await handleRunNow(context, sendToAgent, getSmartAutoContinueMessage);
			break;
			
		case 'injectScript':
			autoInjectScript(context);
			break;
			
		case 'sendInstructions':
			await handleSendInstructions(currentPort, sendToAgent);
			break;
			
		case 'saveNewTask':
			await handleSaveNewTask(message, panel, context, currentPort, getConfig);
			break;
			
		case 'updateTaskField':
			await handleUpdateTaskField(message, panel, context, currentPort, getConfig);
			break;
			
		case 'updateTaskStatus':
			await handleUpdateTaskStatus(message, panel, context, currentPort, getConfig);
			break;
			
		case 'createTask':
			await handleCreateTask(panel, context, currentPort, getConfig);
			break;
			
		case 'openTaskManager':
			await vscode.commands.executeCommand('ai-dev-assistant-bridge.listTasks');
			break;
			
		case 'clearCompleted':
			await handleClearCompleted(panel, context, currentPort, getConfig);
			break;
			
		case 'addGuidingDocument':
			await vscode.commands.executeCommand('ai-dev-assistant-bridge.addGuidingDocument');
			// Refresh panel after adding
			const addedDocs = guidingDocuments.getGuidingDocuments();
			const addedTasks = await taskManager.getTasks(context);
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, addedTasks, addedDocs);
			break;
			
		case 'removeGuidingDocument':
			await guidingDocuments.removeGuidingDocument(message.filePath);
			// Refresh panel after removing
			const removedDocs = guidingDocuments.getGuidingDocuments();
			const removedTasks = await taskManager.getTasks(context);
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, removedTasks, removedDocs);
			break;
			
		case 'manageGuidingDocuments':
			await vscode.commands.executeCommand('ai-dev-assistant-bridge.listGuidingDocuments');
			break;
			
		case 'addCustomCategory':
			await vscode.commands.executeCommand('ai-dev-assistant-bridge.addCustomCategory');
			// Refresh panel after adding
			const addedCatDocs = guidingDocuments.getGuidingDocuments();
			const addedCatTasks = await taskManager.getTasks(context);
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, addedCatTasks, addedCatDocs);
			break;
			
		case 'manageCustomCategories':
			await vscode.commands.executeCommand('ai-dev-assistant-bridge.manageCustomCategories');
			// Refresh panel after managing
			const managedCatDocs = guidingDocuments.getGuidingDocuments();
			const managedCatTasks = await taskManager.getTasks(context);
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, managedCatTasks, managedCatDocs);
			break;
			
		case 'editCustomCategory':
			// Get the category and show edit dialog
			const categories = customCategories.getCustomCategories();
			const catToEdit = categories.find(c => c.id === message.categoryId);
			if (catToEdit) {
				await customCategories.showEditCustomCategoryDialog(catToEdit);
				// Refresh panel after editing
				const editedCatDocs = guidingDocuments.getGuidingDocuments();
				const editedCatTasks = await taskManager.getTasks(context);
				panel.webview.html = await getSettingsHtml(getConfig(), currentPort, editedCatTasks, editedCatDocs);
			}
			break;
			
		case 'updateCustomCategory':
			// Handle inline custom category updates
			const updateField = message.field;
			const updateValue = message.value;
			const updates: any = {};
			updates[updateField] = updateValue;
			
			await customCategories.updateCustomCategory(message.categoryId, updates);
			log(LogLevel.INFO, `Custom category ${message.categoryId} updated: ${updateField} = ${updateValue}`);
			break;
			
		case 'editCustomCategoryField':
			// Handle click-to-edit for name and emoji
			const field = message.field;
			const currentValue = message.currentValue;
			let newValue: string | undefined;
			
			if (field === 'name') {
				newValue = await vscode.window.showInputBox({
					prompt: 'Enter category name',
					value: currentValue,
					validateInput: (value) => {
						if (!value || value.trim().length === 0) {
							return 'Name cannot be empty';
						}
						if (value.length > 50) {
							return 'Name must be 50 characters or less';
						}
						return null;
					}
				});
			} else if (field === 'emoji') {
				newValue = await vscode.window.showInputBox({
					prompt: 'Enter emoji (optional, max 4 characters)',
					value: currentValue,
					validateInput: (value) => {
						if (value && value.length > 4) {
							return 'Emoji must be 4 characters or less';
						}
						return null;
					}
				});
			}
			
			if (newValue !== undefined && newValue !== currentValue) {
				const fieldUpdates: any = {};
				fieldUpdates[field] = newValue;
				await customCategories.updateCustomCategory(message.categoryId, fieldUpdates);
				// Refresh panel
				const refreshDocs = guidingDocuments.getGuidingDocuments();
				const refreshTasks = await taskManager.getTasks(context);
				panel.webview.html = await getSettingsHtml(getConfig(), currentPort, refreshTasks, refreshDocs);
			}
			break;
	}
}

/**
 * Handle "Run Now" button click
 */
async function handleRunNow(
	context: vscode.ExtensionContext,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>,
	getSmartAutoContinueMessage: (context: vscode.ExtensionContext, force: boolean) => Promise<string | null>
): Promise<void> {
	try {
		const message = await getSmartAutoContinueMessage(context, true); // force = true
		if (message) {
			await sendToAgent(message, { 
				source: 'manual_trigger', 
				timestamp: new Date().toISOString()
			});
			log(LogLevel.INFO, '[Run Now] Manually triggered all enabled reminders');
		} else {
			vscode.window.showInformationMessage('No enabled categories (check settings)');
		}
	} catch (error) {
		log(LogLevel.ERROR, '[Run Now] Failed to send message', { 
			error: getErrorMessage(error)
		});
		vscode.window.showErrorMessage('Failed to send reminders');
	}
}

/**
 * Handle "Send Instructions" button click
 */
async function handleSendInstructions(
	currentPort: number,
	sendToAgent: (message: string, context?: unknown) => Promise<boolean>
): Promise<void> {
	try {
		const instructions = '📋 AI Dev Assistant Bridge - Usage Instructions\\n\\n' +
			'This extension helps coordinate between external apps and AI agents in VS Code.\\n\\n' +
			'🎯 Key Features:\\n' +
			'1. **Task Management** - Create and track workspace-specific tasks\\n' +
			'   - Click any title/description to edit inline\\n' +
			'   - Click status icon (⏳/🔄) to cycle status\\n' +
			'   - Tasks auto-sync with external API at http://localhost:' + currentPort + '/tasks\\n\\n' +
			'2. **Auto-Continue System** - Periodic AI reminders\\n' +
			'   - Configure categories: tasks, improvements, coverage, robustness, cleanup, commits\\n' +
			'   - Customize messages and intervals\\n' +
			'   - "Run Now" button triggers all reminders immediately\\n\\n' +
			'3. **Guiding Documents** - Project context for AI\\n' +
			'   - Add ARCHITECTURE.md, CONVENTIONS.md, etc.\\n' +
			'   - Documents automatically included in AI prompts\\n' +
			'   - Manage in settings panel below\\n\\n' +
			'4. **AI Communication Queue** - External AI coordination\\n' +
			'   - POST /ai/queue - Send instructions from external apps\\n' +
			'   - GET /ai/queue - View queued instructions\\n' +
			'   - POST /ai/queue/process - Process next instruction\\n' +
			'   - Priorities: urgent > high > normal > low\\n' +
			'   - Perfect for multi-agent systems\\n\\n' +
			'5. **External API** - HTTP endpoints for automation\\n' +
			'   - GET /tasks - List all workspace tasks\\n' +
			'   - POST /tasks - Create new task\\n' +
			'   - PUT /tasks/:id - Update task status\\n' +
			'   - GET /help - Full API documentation\\n' +
			'   - Server auto-starts on port ' + currentPort + '\\n\\n' +
			'6. **Auto-Approval Script** - Browser dev tools automation\\n' +
			'   - "Inject Script" copies script to clipboard\\n' +
			'   - Paste in VS Code Developer Tools console\\n' +
			'   - Auto-clicks "Allow" and "Keep" buttons\\n\\n' +
			'💡 Quick Start:\\n' +
			'- Add tasks inline by clicking "Add Task"\\n' +
			'- Configure auto-continue in settings below\\n' +
			'- External apps can POST to http://localhost:' + currentPort + '/tasks\\n' +
			'- Check Command Palette for "AI Dev Assistant Bridge" commands\\n\\n' +
			'📖 For full API docs, visit: http://localhost:' + currentPort + '/help';
		
		await sendToAgent(instructions, {
			source: 'instructions',
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		vscode.window.showErrorMessage('Failed to send instructions');
	}
}

/**
 * Handle saving a new task
 */
async function handleSaveNewTask(
	message: any,
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration
): Promise<void> {
	try {
		await taskManager.addTask(context, message.title, message.description, message.category);
		const createdTasks = await taskManager.getTasks(context);
		const createdDocs = guidingDocuments.getGuidingDocuments();
		panel.webview.html = await getSettingsHtml(getConfig(), currentPort, createdTasks, createdDocs);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to create task: ${getErrorMessage(error)}`);
	}
}

/**
 * Handle updating a task field
 */
async function handleUpdateTaskField(
	message: any,
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration
): Promise<void> {
	try {
		const allTasks = await taskManager.getTasks(context);
		const task = allTasks.find(t => t.id === message.taskId);
		if (task) {
			if (message.field === 'title') {
				task.title = message.value;
			} else if (message.field === 'description') {
				task.description = message.value;
			}
			task.updatedAt = new Date().toISOString();
			await taskManager.saveTasks(context, allTasks);
			const updatedTasks = await taskManager.getTasks(context);
			const updatedDocs = guidingDocuments.getGuidingDocuments();
			panel.webview.html = await getSettingsHtml(getConfig(), currentPort, updatedTasks, updatedDocs);
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to update task: ${getErrorMessage(error)}`);
	}
}

/**
 * Handle updating task status
 */
async function handleUpdateTaskStatus(
	message: any,
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration
): Promise<void> {
	try {
		await taskManager.updateTaskStatus(context, message.taskId, message.status);
		const statusTasks = await taskManager.getTasks(context);
		const statusDocs = guidingDocuments.getGuidingDocuments();
		panel.webview.html = await getSettingsHtml(getConfig(), currentPort, statusTasks, statusDocs);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to update status: ${getErrorMessage(error)}`);
	}
}

/**
 * Handle creating a task via command
 */
async function handleCreateTask(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration
): Promise<void> {
	await vscode.commands.executeCommand('ai-dev-assistant-bridge.addTask');
	const taskListAfterCreate = await taskManager.getTasks(context);
	const docsAfterCreate = guidingDocuments.getGuidingDocuments();
	panel.webview.html = await getSettingsHtml(getConfig(), currentPort, taskListAfterCreate, docsAfterCreate);
}

/**
 * Handle clearing completed tasks
 */
async function handleClearCompleted(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	currentPort: number,
	getConfig: () => vscode.WorkspaceConfiguration
): Promise<void> {
	try {
		const clearedCount = await taskManager.clearCompletedTasks(context);
		const remainingTasks = await taskManager.getTasks(context);
		const remainingDocs = guidingDocuments.getGuidingDocuments();
		panel.webview.html = await getSettingsHtml(getConfig(), currentPort, remainingTasks, remainingDocs);
		log(LogLevel.DEBUG, `Cleared ${clearedCount} completed tasks`);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to clear completed tasks: ${getErrorMessage(error)}`);
	}
}

/**
 * Generate HTML for settings panel
 */
async function getSettingsHtml(config: vscode.WorkspaceConfiguration, actualPort: number, tasks: Task[], docs: string[]): Promise<string> {
	const categories = [
		{ key: 'tasks', icon: '📋', name: 'Tasks', interval: 300 },
		{ key: 'improvements', icon: '✨', name: 'Improvements', interval: 600 },
		{ key: 'coverage', icon: '🧪', name: 'Coverage', interval: 900 },
		{ key: 'robustness', icon: '🛡️', name: 'Robustness', interval: 600 },
		{ key: 'cleanup', icon: '🧹', name: 'Cleanup', interval: 120 },
		{ key: 'commits', icon: '💾', name: 'Commits', interval: 900 }
	];

	const autoContinueEnabled = config.get<boolean>('autoContinue.enabled', false);
	const autoApprovalEnabled = config.get<boolean>('autoApproval.enabled', true);
	const autoInjectEnabled = config.get<boolean>('autoApproval.autoInject', false);
	const includeTasksEnabled = config.get<boolean>('autoContinue.includeTasks', true);

	let categoriesRows = '';
	for (const cat of categories) {
		const enabled = config.get<boolean>(`autoContinue.${cat.key}.enabled`, true);
		const interval = config.get<number>(`autoContinue.${cat.key}.interval`, cat.interval);
		const message = config.get<string>(`autoContinue.${cat.key}.message`, '');
		
		categoriesRows += `
			<tr class="${enabled ? '' : 'disabled'}">
				<td class="cat-icon">${cat.icon}</td>
				<td class="cat-name">${cat.name}</td>
				<td class="cat-message">
					<input type="text" value="${message}" data-key="autoContinue.${cat.key}.message" 
					       placeholder="Enter message..." 
					       style="width: 100%; padding: 4px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px;" 
					       ${enabled ? '' : 'disabled'} data-auto-approved="skip">
				</td>
				<td class="cat-interval">
					<input type="number" value="${interval}" data-key="autoContinue.${cat.key}.interval" 
					       min="60" step="60" style="width: 70px;" ${enabled ? '' : 'disabled'} data-auto-approved="skip">s
				</td>
				<td class="cat-toggle">
					<input type="checkbox" data-key="autoContinue.${cat.key}.enabled" ${enabled ? 'checked' : ''} 
					       class="toggle-cb" id="cb-${cat.key}" data-auto-approved="skip">
					<label for="cb-${cat.key}" class="toggle-label" data-auto-approved="skip"></label>
				</td>
			</tr>
		`;
	}

	// Add custom categories
	const customCats = customCategories.getCustomCategories();
	for (const cat of customCats) {
		const emoji = cat.emoji || '⭐';
		categoriesRows += `
			<tr class="${cat.enabled ? '' : 'disabled'}" data-custom-id="${cat.id}">
				<td class="cat-icon" style="cursor: pointer;" onclick="editCustomCategoryEmoji('${cat.id}', '${emoji}')" title="Click to change emoji">${emoji}</td>
				<td class="cat-name" style="color: var(--vscode-textLink-foreground); cursor: pointer; font-weight: 500;" onclick="editCustomCategoryName('${cat.id}', '${cat.name}')" title="Click to rename">${cat.name}</td>
				<td class="cat-message">
					<input type="text" value="${cat.message}" data-custom-id="${cat.id}" data-custom-field="message" 
					       placeholder="Enter message..." 
					       style="width: 100%; padding: 4px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px;" 
					       ${cat.enabled ? '' : 'disabled'} data-auto-approved="skip">
				</td>
				<td class="cat-interval">
					<input type="number" value="${cat.interval}" data-custom-id="${cat.id}" data-custom-field="interval" 
					       min="60" max="86400" step="60" style="width: 70px;" ${cat.enabled ? '' : 'disabled'} data-auto-approved="skip">s
				</td>
				<td class="cat-toggle">
					<input type="checkbox" data-custom-id="${cat.id}" data-custom-field="enabled" ${cat.enabled ? 'checked' : ''} 
					       class="toggle-cb" id="cb-custom-${cat.id}" data-auto-approved="skip">
					<label for="cb-custom-${cat.id}" class="toggle-label" data-auto-approved="skip"></label>
				</td>
			</tr>
		`;
	}

	// Generate task rows HTML
	const activeTasks = tasks.filter(t => t.status !== 'completed').reverse();
	const completedCount = tasks.filter(t => t.status === 'completed').length;
	
	const taskSectionHtml = activeTasks.length === 0 ? `
		<div class="row">
			<label style="color: var(--vscode-descriptionForeground); font-style: italic;">No active tasks for this workspace</label>
			<button onclick="createTask()">Add Task</button>
		</div>
		${completedCount > 0 ? `
		<div class="row" style="margin-top: 8px;">
			<label style="font-size: 12px; color: var(--vscode-descriptionForeground);">${completedCount} completed task${completedCount > 1 ? 's' : ''}</label>
			<button onclick="clearCompleted()">Clear Completed</button>
		</div>
		` : ''}
	` : `
		<table id="task-table">
			<thead>
				<tr>
					<th style="width: 40px;"></th>
					<th>Title</th>
					<th>Description</th>
					<th style="width: 120px;">Category</th>
					<th style="width: 100px;">Status</th>
				</tr>
			</thead>
			<tbody id="task-tbody">
				${activeTasks.map(t => {
					const statusIcon = t.status === 'pending' ? '⏳' : t.status === 'in-progress' ? '🔄' : '✅';
					const statusText = t.status === 'pending' ? 'Pending' : t.status === 'in-progress' ? 'In Progress' : 'Completed';
					const statusColor = t.status === 'pending' ? '#cca700' : t.status === 'in-progress' ? '#3794ff' : '#89d185';
					return `
					<tr>
						<td style="cursor: pointer; font-size: 18px;" onclick="cycleStatus('${t.id}', '${t.status}')" title="Click to cycle status">${statusIcon}</td>
						<td style="cursor: pointer; font-weight: 500;" onclick="editField(this, '${t.id}', 'title')">${t.title}</td>
						<td style="cursor: pointer; opacity: 0.8; font-size: 13px;" onclick="editField(this, '${t.id}', 'description')">${t.description || '<span style="opacity: 0.5;">(click to add description)</span>'}</td>
						<td style="font-size: 12px; opacity: 0.7;">${t.category}</td>
						<td style="color: ${statusColor}; font-size: 12px;">${statusText}</td>
					</tr>
				`;}).join('')}
			</tbody>
		</table>
		<div class="row" style="margin-top: 8px;">
			<button onclick="createTask()">Add Task</button>
			<button onclick="openTaskManager()">Manage Tasks</button>
			${completedCount > 0 ? `<button onclick="clearCompleted()">Clear Completed (${completedCount})</button>` : ''}
		</div>
	`;

	// Generate guiding documents section HTML
	const guidingDocsHtml = docs.length === 0 ? `
		<div class="row">
			<label style="color: var(--vscode-descriptionForeground); font-style: italic;">No guiding documents configured</label>
			<button onclick="addGuidingDocument()">Add Document</button>
		</div>
	` : `
		<table>
			<thead>
				<tr>
					<th style="width: 40px;">📄</th>
					<th>Document</th>
					<th style="width: 100px;">Actions</th>
				</tr>
			</thead>
			<tbody>
				${docs.map(doc => {
					const fileName = doc.split('/').pop() || doc.split('\\').pop() || doc;
					return `
					<tr>
						<td style="font-size: 16px;">📄</td>
						<td style="font-size: 13px; font-family: monospace; opacity: 0.9;">${doc}</td>
						<td>
							<button onclick="removeGuidingDoc('${doc.replace(/'/g, "\\'")}')">Remove</button>
						</td>
					</tr>
				`;}).join('')}
			</tbody>
		</table>
		<div class="row" style="margin-top: 8px;">
			<button onclick="addGuidingDocument()">Add Document</button>
		</div>
	`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Settings</title>
	<style>
		${getSettingsStyles()}
	</style>
</head>
<body>
	<div class="header">
		<h1>🌉 AI Dev Assistant Bridge</h1>
		<button onclick="runNow()">Run Now</button>
		<button onclick="injectScript()">Inject Script</button>
		<button onclick="sendInstructions()">Send Instructions</button>
	</div>
	
	<div class="section">
		<div class="section-title">Server</div>
		<div class="row">
			<label>Port (auto-assigned)</label>
			<span class="port-display">${actualPort}</span>
		</div>
	</div>
	
	<div class="section">
		<div class="section-title">Auto-Approval</div>
		<div class="row">
			<label>Enable monitoring</label>
			<div style="display: flex; align-items: center; gap: 8px;">
				<input type="checkbox" data-key="autoApproval.enabled" ${autoApprovalEnabled ? 'checked' : ''} 
				       class="toggle-cb" id="cb-approval" data-auto-approved="skip">
				<label for="cb-approval" class="toggle-label" data-auto-approved="skip"></label>
			</div>
		</div>
		<div class="row">
			<label>Auto-inject script on startup</label>
			<div style="display: flex; align-items: center; gap: 8px;">
				<input type="checkbox" data-key="autoApproval.autoInject" ${autoInjectEnabled ? 'checked' : ''} 
				       class="toggle-cb" id="cb-autoinject" ${autoApprovalEnabled ? '' : 'disabled'} data-auto-approved="skip">
				<label for="cb-autoinject" class="toggle-label" data-auto-approved="skip"></label>
			</div>
		</div>
	</div>
	
	<div class="section">
		<div class="section-title">Auto-Continue</div>
		<div class="row" style="margin-bottom: 8px;">
			<label>Enable reminders</label>
			<div style="display: flex; align-items: center; gap: 8px;">
				<input type="checkbox" data-key="autoContinue.enabled" ${autoContinueEnabled ? 'checked' : ''} 
				       class="toggle-cb" id="cb-autocontinue" data-auto-approved="skip">
				<label for="cb-autocontinue" class="toggle-label" data-auto-approved="skip"></label>
			</div>
		</div>
		<div class="row" style="margin-bottom: 12px;">
			<label>Include tasks in reminders</label>
			<div style="display: flex; align-items: center; gap: 8px;">
				<input type="checkbox" data-key="autoContinue.includeTasks" ${includeTasksEnabled ? 'checked' : ''} 
				       class="toggle-cb" id="cb-includetasks" ${autoContinueEnabled ? '' : 'disabled'} data-auto-approved="skip">
				<label for="cb-includetasks" class="toggle-label" data-auto-approved="skip"></label>
			</div>
		</div>
		<table>
			<thead>
				<tr>
					<th></th>
					<th>Category</th>
					<th>Message</th>
					<th>Interval</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				${categoriesRows}
			</tbody>
		</table>
		<div class="row" style="margin-top: 12px;">
			<button onclick="addCustomCategory()">Add Custom Category</button>
			<button onclick="manageCustomCategories()">Manage Custom Categories</button>
		</div>
	</div>
	
	<div class="section">
		<div class="section-title">Task Management (Workspace)</div>
		${taskSectionHtml}
	</div>
	
	<div class="section">
		<div class="section-title">Guiding Documents (AI Context)</div>
		<div class="row" style="margin-bottom: 8px;">
			<label style="color: var(--vscode-descriptionForeground); font-size: 13px;">
				Project documents included as context in AI prompts
			</label>
		</div>
		${guidingDocsHtml}
	</div>
	
	<script>
		${getSettingsScript()}
	</script>
</body>
</html>`;
}

/**
 * Get CSS styles for settings panel
 */
function getSettingsStyles(): string {
	return `
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			font-size: 14px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
			max-width: 800px;
		}
		
		.header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
			padding-bottom: 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.header h1 { font-size: 18px; flex: 1; font-weight: 600; }
		
		.section {
			background: var(--vscode-sideBar-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			padding: 10px 12px;
			margin-bottom: 10px;
		}
		.section-title {
			font-weight: 600;
			margin-bottom: 8px;
			font-size: 14px;
		}
		
		.row {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 4px 0;
		}
		.row label { flex: 1; font-size: 14px; }
		
		table {
			width: 100%;
			border-collapse: collapse;
		}
		th {
			text-align: left;
			padding: 6px 4px;
			font-weight: 600;
			font-size: 12px;
			opacity: 0.7;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		td {
			padding: 6px 4px;
			border-bottom: 1px solid rgba(128,128,128,0.1);
		}
		tr.disabled { opacity: 0.5; }
		.cat-icon { width: 28px; font-size: 16px; }
		.cat-name { width: 120px; font-weight: 500; font-size: 14px; }
		.cat-message { min-width: 250px; max-width: 400px; font-size: 14px; }
		.cat-interval { width: 100px; font-size: 14px; }
		.cat-toggle { width: 45px; text-align: right; }
		
		input[type="number"] {
			padding: 3px 5px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 3px;
			font-size: 14px;
		}
		
		.toggle-cb { display: none; }
		.toggle-label {
			display: inline-block;
			width: 32px;
			height: 16px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 8px;
			position: relative;
			cursor: pointer;
			transition: all 0.2s;
		}
		.toggle-label:after {
			content: '';
			position: absolute;
			width: 10px;
			height: 10px;
			border-radius: 50%;
			background: var(--vscode-input-foreground);
			top: 2.5px;
			left: 2.5px;
			transition: all 0.2s;
		}
		.toggle-cb:checked + .toggle-label {
			background: var(--vscode-button-background);
			border-color: var(--vscode-button-background);
		}
		.toggle-cb:checked + .toggle-label:after {
			left: 18.5px;
			background: white;
		}
		
		button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 6px 12px;
			border-radius: 3px;
			cursor: pointer;
			font-size: 13px;
			font-family: var(--vscode-font-family);
		}
		button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		
		.port-display {
			font-family: 'Monaco', 'Courier New', monospace;
			font-weight: 600;
			color: var(--vscode-textLink-foreground);
			font-size: 14px;
		}
	`;
}

/**
 * Get JavaScript for settings panel
 */
function getSettingsScript(): string {
	return `
		const vscode = acquireVsCodeApi();
		
		// Handle all input changes
		document.querySelectorAll('input').forEach(el => {
			el.addEventListener('change', (e) => {
				// Check if this is a custom category input
				const customId = e.target.dataset.customId;
				const customField = e.target.dataset.customField;
				
				if (customId && customField) {
					// Handle custom category update
					let value = e.target.type === 'checkbox' ? e.target.checked : 
					           e.target.type === 'number' ? parseInt(e.target.value) : 
					           e.target.value;
					
					vscode.postMessage({
						command: 'updateCustomCategory',
						categoryId: customId,
						field: customField,
						value: value
					});
					
					// Update row state for custom category enabled toggle
					if (customField === 'enabled') {
						const row = e.target.closest('tr');
						if (row) {
							row.classList.toggle('disabled', !value);
							const messageInput = row.querySelector('input[type="text"]');
							if (messageInput) messageInput.disabled = !value;
							const intervalInput = row.querySelector('input[type="number"]');
							if (intervalInput) intervalInput.disabled = !value;
						}
					}
					return;
				}
				
				const key = e.target.dataset.key;
				if (!key) return;
				
				let value = e.target.type === 'checkbox' ? e.target.checked : 
				           e.target.type === 'number' ? parseInt(e.target.value) : 
				           e.target.value;
				
				vscode.postMessage({
					command: 'updateSetting',
					key: key,
					value: value
				});
				
				// Update row state for auto-continue categories
				if (key.includes('.enabled')) {
					const row = e.target.closest('tr');
					if (row) {
						row.classList.toggle('disabled', !value);
						const messageInput = row.querySelector('input[type="text"]');
						if (messageInput) messageInput.disabled = !value;
						const intervalInput = row.querySelector('input[type="number"]');
						if (intervalInput) intervalInput.disabled = !value;
					}
				}
				
				// Handle auto-approval enabled toggle
				if (key === 'autoApproval.enabled') {
					const autoInjectCheckbox = document.getElementById('cb-autoinject');
					if (autoInjectCheckbox) {
						autoInjectCheckbox.disabled = !value;
					}
				}
			});
		});
		
		function runNow() {
			vscode.postMessage({ command: 'runNow' });
		}
		
		function injectScript() {
			vscode.postMessage({ command: 'injectScript' });
		}
		
		function createTask() {
			const tbody = document.getElementById('task-tbody');
			if (!tbody) {
				vscode.postMessage({ command: 'createTask' });
				return;
			}
			
			if (document.getElementById('new-task-row')) {
				return;
			}
			
			const newRow = document.createElement('tr');
			newRow.id = 'new-task-row';
			newRow.style.opacity = '0.7';
			newRow.innerHTML = \`
				<td>⏳</td>
				<td><input type="text" id="new-title" placeholder="Task title..." style="width: 100%; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);" autofocus></td>
				<td><input type="text" id="new-description" placeholder="Description (optional)..." style="width: 100%; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);"></td>
				<td>
					<select id="new-category" style="padding: 4px; font-size: 12px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);">
						<option value="bug">bug</option>
						<option value="feature">feature</option>
						<option value="improvement">improvement</option>
						<option value="documentation">documentation</option>
						<option value="testing">testing</option>
						<option value="other">other</option>
					</select>
				</td>
				<td>
					<button onclick="saveNewTask()" style="padding: 4px 12px; font-size: 12px;">Save</button>
				</td>
			\`;
			
			tbody.insertBefore(newRow, tbody.firstChild);
			document.getElementById('new-title').focus();
			
			document.getElementById('new-title').addEventListener('keydown', (e) => {
				if (e.key === 'Enter') saveNewTask();
				if (e.key === 'Escape') cancelNewTask();
			});
			document.getElementById('new-description').addEventListener('keydown', (e) => {
				if (e.key === 'Enter') saveNewTask();
				if (e.key === 'Escape') cancelNewTask();
			});
		}
		
		function saveNewTask() {
			const title = document.getElementById('new-title')?.value.trim();
			const description = document.getElementById('new-description')?.value.trim();
			const category = document.getElementById('new-category')?.value;
			
			if (!title) {
				cancelNewTask();
				return;
			}
			
			vscode.postMessage({ 
				command: 'saveNewTask',
				title: title,
				description: description || '',
				category: category || 'other'
			});
		}
		
		function cancelNewTask() {
			const row = document.getElementById('new-task-row');
			if (row) row.remove();
		}
		
		function editField(cell, taskId, field) {
			const currentValue = cell.textContent.trim();
			const input = document.createElement('input');
			input.type = 'text';
			input.value = currentValue.includes('click to add') ? '' : currentValue;
			input.style.cssText = 'width:100%;padding:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)';
			
			const save = () => {
				const newValue = input.value.trim();
				if (newValue && newValue !== currentValue) {
					vscode.postMessage({ command: 'updateTaskField', taskId, field, value: newValue });
				} else {
					cell.textContent = currentValue;
				}
			};
			
			input.addEventListener('blur', save);
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') save();
				else if (e.key === 'Escape') cell.textContent = currentValue;
			});
			
			cell.textContent = '';
			cell.appendChild(input);
			input.focus();
			input.select();
		}
		
		function cycleStatus(taskId, currentStatus) {
			const nextStatus = currentStatus === 'pending' ? 'in-progress' : 
			                   currentStatus === 'in-progress' ? 'completed' : 'pending';
			vscode.postMessage({ command: 'updateTaskStatus', taskId, status: nextStatus });
		}
		
		function openTaskManager() {
			vscode.postMessage({ command: 'openTaskManager' });
		}
		
		function clearCompleted() {
			vscode.postMessage({ command: 'clearCompleted' });
		}
		
		function sendInstructions() {
			vscode.postMessage({ command: 'sendInstructions' });
		}
		
		function addGuidingDocument() {
			vscode.postMessage({ command: 'addGuidingDocument' });
		}
		
		function removeGuidingDoc(filePath) {
			vscode.postMessage({ command: 'removeGuidingDocument', filePath });
		}
		
		function manageGuidingDocuments() {
			vscode.postMessage({ command: 'manageGuidingDocuments' });
		}
		
		function addCustomCategory() {
			vscode.postMessage({ command: 'addCustomCategory' });
		}
		
		function manageCustomCategories() {
			vscode.postMessage({ command: 'manageCustomCategories' });
		}
		
		function editCustomCategory(categoryId) {
			vscode.postMessage({ command: 'editCustomCategory', categoryId });
		}
		
		function editCustomCategoryName(categoryId, currentName) {
			vscode.postMessage({ 
				command: 'editCustomCategoryField', 
				categoryId, 
				field: 'name',
				currentValue: currentName
			});
		}
		
		function editCustomCategoryEmoji(categoryId, currentEmoji) {
			vscode.postMessage({ 
				command: 'editCustomCategoryField', 
				categoryId, 
				field: 'emoji',
				currentValue: currentEmoji
			});
		}
	`;
}

/**
 * Refresh settings panel if it's open
 */
export async function refreshSettingsPanel(
	context: vscode.ExtensionContext,
	getConfig: () => vscode.WorkspaceConfiguration,
	currentPort: number
): Promise<void> {
	if (settingsPanel) {
		const tasks = await taskManager.getTasks(context);
		const docs = guidingDocuments.getGuidingDocuments();
		settingsPanel.webview.html = await getSettingsHtml(getConfig(), currentPort, tasks, docs);
		log(LogLevel.DEBUG, 'Settings panel refreshed');
	}
}
