// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';

// Import modules
import { Task, LogLevel } from './modules/types';
import { initLogging, log, getErrorMessage } from './modules/logging';
import * as taskManager from './modules/taskManager';
import * as portManager from './modules/portManager';
import * as server from './modules/server';
import { autoInjectScript } from './modules/autoApproval';
import * as settingsPanelModule from './modules/settingsPanel';
import * as chatIntegration from './modules/chatIntegration';
import * as autoContinue from './modules/autoContinue';
import * as statusBar from './modules/statusBar';
import * as commands from './modules/commands';
import * as aiQueue from './modules/aiQueue';
import { formatCountdown } from './modules/timeFormatting';

let outputChannel: vscode.OutputChannel;
let currentPort: number = 3737;
let autoApprovalInterval: NodeJS.Timeout | undefined;
let countdownUpdateTimer: NodeJS.Timeout | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Get configuration with proper scope for window isolation
 * This ensures each VS Code window can have independent settings
 */
function getConfig(): vscode.WorkspaceConfiguration {
	// Get workspace-specific configuration
	return vscode.workspace.getConfiguration('aiDevAssistantBridge');
}

/**
 * Update configuration for workspace scope
 */
async function updateConfig(key: string, value: unknown): Promise<void> {
	const config = getConfig();
	// Use Workspace target if workspace is open, otherwise use Global
	const target = vscode.workspace.workspaceFolders 
		? vscode.ConfigurationTarget.Workspace 
		: vscode.ConfigurationTarget.Global;
	await config.update(key, value, target);
	
	log(LogLevel.DEBUG, `Config updated: ${key} = ${value}`, {
		scope: target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'Global',
		newValue: config.get(key)
	});
}

export async function activate(context: vscode.ExtensionContext) {
	// Store context globally for deactivation
	extensionContext = context;

	// Create output channel for logs
	outputChannel = vscode.window.createOutputChannel('AI Agent Feedback');
	context.subscriptions.push(outputChannel);
	
	// Initialize logging module
	initLogging(outputChannel);
	
	// Initialize chat integration module
	chatIntegration.initChat(outputChannel);
	
	log(LogLevel.INFO, '🚀 AI Agent Feedback Bridge activated');

	// Auto-select available port (or use configured port if valid)
	const config = getConfig();
	
	// MIGRATION: Clear any old Global settings to force workspace scope
	const globalConfig = vscode.workspace.getConfiguration('aiDevAssistantBridge');
	const globalEnabled = globalConfig.inspect<boolean>('autoContinue.enabled');
	if (globalEnabled?.globalValue !== undefined) {
		log(LogLevel.WARN, 'Detected old Global settings, clearing to use Workspace scope');
		await globalConfig.update('autoContinue.enabled', undefined, vscode.ConfigurationTarget.Global);
	}
	
	const configuredPort = config.get<number>('port');
	
	// Always use auto-selection to ensure each window gets unique port
	// Don't save back to config - let each window find its own port
	currentPort = await portManager.findAvailablePort(context);
	log(LogLevel.INFO, `Auto-selected port: ${currentPort} for this window`);
	
	// Log window identification to help debug multi-window scenarios
	const workspaceName = vscode.workspace.name || 'No Workspace';
	const workspaceFolders = vscode.workspace.workspaceFolders?.length || 0;
	log(LogLevel.INFO, `Window context: ${workspaceName} (${workspaceFolders} folders)`);

	// Initialize status bar items
	statusBar.initializeStatusBar(context, currentPort, config);

	// Register all commands
	commands.registerCommands({
		context,
		currentPort,
		getConfig,
		updateConfig,
		sendToAgent: chatIntegration.sendToAgent,
		autoInjectScript,
		enableAutoApproval,
		disableAutoApproval,
		injectAutoApprovalScript,
		startCountdownUpdates,
		stopCountdownUpdates,
		outputChannel,
		server: server.getServer()
	});

	// Start HTTP server to receive feedback
	startFeedbackServer(context);

	// Write port discovery file to each workspace folder
	portManager.writeBridgePortFiles(currentPort);

	// Start auto-continue only if enabled in config
	const autoEnabled = config.get<boolean>('autoContinue.enabled', false);
	const inspectValue = config.inspect<boolean>('autoContinue.enabled');
	
	log(LogLevel.INFO, `[STARTUP] Auto-Continue check:`, {
		enabled: autoEnabled,
		defaultValue: inspectValue?.defaultValue,
		globalValue: inspectValue?.globalValue,
		workspaceValue: inspectValue?.workspaceValue,
		workspaceFolderValue: inspectValue?.workspaceFolderValue
	});
	
	if (autoEnabled) {
		autoContinue.startAutoContinue(context, getConfig, chatIntegration.sendToAgent);
		startCountdownUpdates(context);
	} else {
		log(LogLevel.INFO, '[STARTUP] Auto-Continue is disabled, not starting');
	}

	// Initialize auto-approval if enabled
	initializeAutoApproval();

	// Watch for configuration changes (window-scoped)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('aiDevAssistantBridge')) {
				const cfg = getConfig();
				
				log(LogLevel.DEBUG, 'Configuration changed', { 
					workspace: vscode.workspace.name,
					affectedKeys: ['port', 'autoContinue'].filter(k => 
						e.affectsConfiguration(`aiDevAssistantBridge.${k}`)
					)
				});
				
				// Check for port change
				if (e.affectsConfiguration('aiDevAssistantBridge.port')) {
					const newPort = cfg.get<number>('port', 3737);
					if (newPort !== currentPort) {
						log(LogLevel.INFO, `Port change detected: ${currentPort} → ${newPort}. Reloading window...`);
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				}
				
				// Update status bar buttons
				statusBar.updateStatusBar(cfg);
				
				if (e.affectsConfiguration('aiDevAssistantBridge.autoContinue')) {
					autoContinue.restartAutoContinue(context, getConfig, chatIntegration.sendToAgent);
					
					// Restart countdown updates if auto-continue is enabled
					const autoEnabled = cfg.get<boolean>('autoContinue.enabled', false);
					if (autoEnabled) {
						startCountdownUpdates(context);
					} else {
						stopCountdownUpdates();
					}
				}
			}
		})
	);

	// Register chat participant for automatic processing
	chatIntegration.createChatParticipant(context);

	// Log server status (no popup notification)
	log(LogLevel.INFO, `Feedback server started on http://localhost:${currentPort}`);
}

/**
 * Start HTTP server to receive feedback from Electron app
 */
function startFeedbackServer(context: vscode.ExtensionContext) {
	server.startServer(context, currentPort, chatIntegration.sendToAgent);

	// Enable auto-processing of AI queue so external dispatches (e.g. Goltana) get sent to Copilot immediately
	aiQueue.setAutoProcess(true, chatIntegration.sendToAgent);
}

/**
 * Start countdown update timer to refresh status bar with time until next reminder
 */
function startCountdownUpdates(context: vscode.ExtensionContext) {
	// Stop any existing timer
	if (countdownUpdateTimer) {
		clearInterval(countdownUpdateTimer);
	}
	
	// Update every second
	countdownUpdateTimer = setInterval(() => {
		try {
			const config = getConfig();
			const autoEnabled = config.get<boolean>('autoContinue.enabled', false);
			
			if (!autoEnabled) {
				// Stop updating if auto-continue is disabled
				if (countdownUpdateTimer) {
					clearInterval(countdownUpdateTimer);
					countdownUpdateTimer = undefined;
				}
				statusBar.updateStatusBar(config);
				return;
			}
			
			const timeUntilNext = autoContinue.getTimeUntilNextReminder(context, getConfig);
			if (timeUntilNext !== null && timeUntilNext > 0) {
				const countdown = formatCountdown(timeUntilNext);
				statusBar.updateStatusBar(config, countdown);
			} else {
				statusBar.updateStatusBar(config);
			}
		} catch (error) {
			log(LogLevel.ERROR, 'Error updating countdown', { error: getErrorMessage(error) });
		}
	}, 1000);
}

/**
 * Stop countdown update timer
 */
function stopCountdownUpdates() {
	if (countdownUpdateTimer) {
		clearInterval(countdownUpdateTimer);
		countdownUpdateTimer = undefined;
	}
}

/**
 * Initialize auto-approval if enabled in settings
 */
function initializeAutoApproval() {
	const config = getConfig();
	const autoApprovalEnabled = config.get<boolean>('autoApproval.enabled', true);
	const autoInjectEnabled = config.get<boolean>('autoApproval.autoInject', false);
	
	if (autoApprovalEnabled) {
		log(LogLevel.INFO, 'Auto-approval enabled. Use "AI Dev Assistant Bridge: Copy Auto-Approval Script" command to get the script.');
		
		// Auto-inject if enabled
		if (autoInjectEnabled) {
			// Only auto-inject if the setting was explicitly enabled at workspace scope.
			// This prevents user-level/global settings from causing auto-inject in brand-new windows.
			const inspect = config.inspect<boolean>('autoApproval.autoInject');
			const workspaceHasValue = !!(inspect && (inspect.workspaceValue || inspect.workspaceFolderValue));
			if (!workspaceHasValue) {
				log(LogLevel.INFO, 'Skipping auto-inject because autoApproval.autoInject is not set at workspace scope.');
				log(LogLevel.INFO, 'To enable auto-inject for this workspace, set "aiDevAssistantBridge.autoApproval.autoInject" in Workspace Settings.');
				return;
			}

			log(LogLevel.INFO, 'Auto-inject enabled at workspace scope. Launching quick setup...');
			// Minimal delay to ensure extension is fully initialized (1s is sufficient)
			setTimeout(() => {
				autoInjectScript(extensionContext!).catch(err => {
					log(LogLevel.WARN, 'Auto-inject setup failed:', getErrorMessage(err));
				});
			}, 1000);
		}
	}
}

/**
 * Copy auto-approval script to clipboard
 * Simple, non-intrusive - just copy and optionally open dev tools
 */
/**
 * Enable automatic approval of chat buttons
 */
function enableAutoApproval(context: vscode.ExtensionContext) {
	if (autoApprovalInterval) {
		outputChannel.appendLine('Auto-approval is already enabled');
		return;
	}

	const config = getConfig();
	const intervalMs = config.get<number>('autoApproval.intervalMs', 2000);
	
	log(LogLevel.INFO, `Enabling auto-approval with ${intervalMs}ms interval`);
	
	// Note: This uses the executeCommand API to simulate key presses
	// The actual DOM manipulation needs to be done via developer console
	autoApprovalInterval = setInterval(async () => {
		try {
			// Try to accept any pending quick pick items (for "Allow" buttons)
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		} catch (error) {
			// Silently ignore - this is expected when there's nothing to approve
		}
	}, intervalMs);

	// Store interval in context for cleanup
	context.subscriptions.push({
		dispose: () => {
			if (autoApprovalInterval) {
				clearInterval(autoApprovalInterval);
				autoApprovalInterval = undefined;
			}
		}
	});

	log(LogLevel.INFO, 'Auto-approval enabled. Use "AI Dev Assistant Bridge: Copy Auto-Approval Script" command to get the script.');
}

/**
 * Disable automatic approval
 */
function disableAutoApproval() {
	if (autoApprovalInterval) {
		clearInterval(autoApprovalInterval);
		autoApprovalInterval = undefined;
		outputChannel.appendLine('Auto-approval disabled');
		log(LogLevel.INFO, 'Auto-approval disabled');
	} else {
		log(LogLevel.INFO, 'Auto-approval is not currently enabled');
	}
}

/**
 * Show instructions for injecting the DOM manipulation script
 */
function injectAutoApprovalScript() {
	// Import the function from autoApproval module
	const { getAutoApprovalScript } = require('./modules/autoApproval');
	const script = getAutoApprovalScript(extensionContext!);

	const panel = vscode.window.createWebviewPanel(
		'autoApprovalScript',
		'Auto-Approval Script',
		vscode.ViewColumn.One,
		{
			enableScripts: true
		}
	);

	panel.webview.html = getAutoApprovalInstructionsHtml(script);

	// Also copy to clipboard
	vscode.env.clipboard.writeText(script);
	log(LogLevel.INFO, 'Auto-approval script copied to clipboard');
}

/**
 * Generate HTML for the auto-approval instructions webview
 */
function getAutoApprovalInstructionsHtml(script: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Auto-Approval Script</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1 {
            color: var(--vscode-textLink-foreground);
        }
        .step {
            margin: 20px 0;
            padding: 15px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            font-family: monospace;
            font-size: 12px;
            margin: 10px 0;
        }
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 14px;
            margin: 5px;
        }
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .warning {
            color: var(--vscode-editorWarning-foreground);
            padding: 10px;
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 3px;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <h1>🧩 VS Code Chat Auto-Approval System</h1>
    
    <div class="warning">
        ⚠️ <strong>Note:</strong> This script auto-clicks "Allow" and "Keep" buttons in the chat interface.
        Make sure you trust the operations being performed!
    </div>

    <div class="step">
        <h2>📋 Step 1: The script is already copied to your clipboard!</h2>
        <p>Just paste it in the next step.</p>
    </div>

    <div class="step">
        <h2>🔧 Step 2: Open VS Code Developer Tools</h2>
        <p>Go to: <strong>Help → Toggle Developer Tools</strong></p>
        <p>Or use keyboard shortcut: <strong>⌘⌥I</strong> (Mac) / <strong>Ctrl+Shift+I</strong> (Windows/Linux)</p>
    </div>

    <div class="step">
        <h2>💻 Step 3: Paste and run the script</h2>
        <p>1. Click on the <strong>Console</strong> tab in Developer Tools</p>
        <p>2. Paste the script (⌘V / Ctrl+V)</p>
        <p>3. Press <strong>Enter</strong> to execute</p>
    </div>

    <div class="step">
        <h2>✅ What happens next?</h2>
        <ul>
            <li>The script will check every 2 seconds for "Allow" or "Keep" buttons</li>
            <li>When found, it automatically clicks them</li>
            <li>You'll see confirmation messages in the console</li>
            <li>The script includes safety checks to skip dangerous operations (delete, remove, rm)</li>
        </ul>
    </div>

    <div class="step">
        <h2>🛑 To stop the script:</h2>
        <p>In the Developer Console, run:</p>
        <div class="code-block">clearInterval(window.__autoApproveInterval)</div>
    </div>

    <hr style="margin: 30px 0; border: 1px solid var(--vscode-panel-border);">

    <h2>📜 Full Script (already copied):</h2>
    <div class="code-block">${script.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>

    <button class="button" onclick="copyScript()">Copy Script Again</button>

    <script>
        function copyScript() {
            const script = \`${script.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`;
            navigator.clipboard.writeText(script).then(() => {
                alert('Script copied to clipboard!');
            });
        }
    </script>
</body>
</html>`;
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Clean up HTTP server
	server.stopServer();
	log(LogLevel.INFO, 'HTTP server closed');
	
	// Clean up auto-continue timer
	autoContinue.stopAutoContinue();
	
	// Clean up auto-approval interval
	if (autoApprovalInterval) {
		clearInterval(autoApprovalInterval);
		autoApprovalInterval = undefined;
		log(LogLevel.INFO, 'Auto-approval interval cleared');
	}
	
	// Clean up countdown update timer
	stopCountdownUpdates();
	
	// Dispose chat integration
	chatIntegration.disposeChat();
	
	// Release port from registry
	if (extensionContext) {
		await portManager.releasePort(extensionContext, currentPort);
	}
	
	log(LogLevel.INFO, '👋 AI Agent Feedback Bridge deactivated');
}
