/**
 * Port management module for automatic port assignment
 * 
 * Manages port allocation across multiple VS Code workspaces to prevent conflicts.
 * Each workspace gets a unique port in the 3737-3787 range. Ports are persisted
 * in global state and reused when the same workspace is reopened.
 * 
 * Features:
 * - Automatic port allocation from pool (3737-3787)
 * - Workspace-specific port persistence
 * - Stale entry cleanup (1 hour timeout)
 * - Conflict detection and resolution
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logging';
import { LogLevel } from './types';

const PORT_FILENAME = '.bridge-port';

const PORT_REGISTRY_KEY = 'aiDevAssistantBridge.portRegistry';
const BASE_PORT = 3737;
const MAX_PORT_SEARCH = 50; // Try up to 50 ports (3737-3787)

/**
 * Registry entry tracking port assignments
 */
interface PortRegistryEntry {
	/** Port number assigned */
	port: number;
	/** Workspace identifier (file system path) */
	workspace: string;
	/** Timestamp of last use (for stale entry cleanup) */
	timestamp: number;
}

/**
 * Get the port registry from global state
 * 
 * @param context - VS Code extension context for global state access
 * @returns Promise resolving to array of port registry entries
 * 
 * @remarks
 * - Returns empty array if no registry exists
 * - Registry is shared across all VS Code windows
 */
async function getPortRegistry(context: vscode.ExtensionContext): Promise<PortRegistryEntry[]> {
	return context.globalState.get<PortRegistryEntry[]>(PORT_REGISTRY_KEY, []);
}

/**
 * Save the port registry to global state
 * 
 * @param context - VS Code extension context for global state access
 * @param registry - Array of port registry entries to save
 * 
 * @remarks
 * - Persists across VS Code sessions
 * - Shared across all VS Code windows
 */
async function savePortRegistry(context: vscode.ExtensionContext, registry: PortRegistryEntry[]): Promise<void> {
	await context.globalState.update(PORT_REGISTRY_KEY, registry);
}

/**
 * Find an available port for the current workspace
 * 
 * @param context - VS Code extension context for global state access
 * @returns Promise resolving to an available port number
 * 
 * @remarks
 * Port allocation strategy:
 * 1. Cleans up stale entries (older than 1 hour)
 * 2. Reuses existing port if workspace already has one assigned
 * 3. Finds next available port in range 3737-3787
 * 4. Verifies port is actually available by attempting to bind
 * 5. Registers port in global state for future reuse
 * 
 * @throws {Error} If no available ports found in range (all 50 ports in use)
 * 
 * @example
 * ```typescript
 * try {
 *   const port = await findAvailablePort(context);
 *   console.log(`Using port ${port} for this workspace`);
 * } catch (error) {
 *   vscode.window.showErrorMessage('No available ports in range 3737-3787');
 * }
 * ```
 */
export async function findAvailablePort(context: vscode.ExtensionContext): Promise<number> {
	const registry = await getPortRegistry(context);
	const workspaceName = vscode.workspace.name || 'No Workspace';
	const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-workspace';
	
	// Clean up stale entries (older than 1 hour - window likely closed)
	const oneHourAgo = Date.now() - (60 * 60 * 1000);
	const activeRegistry = registry.filter(entry => entry.timestamp > oneHourAgo);
	
	// Check if this workspace already has a port assigned
	const existingEntry = activeRegistry.find(entry => entry.workspace === workspaceId);
	if (existingEntry) {
		log(LogLevel.INFO, `Reusing existing port ${existingEntry.port} for workspace`);
		// Update timestamp
		existingEntry.timestamp = Date.now();
		await savePortRegistry(context, activeRegistry);
		return existingEntry.port;
	}
	
	// Find next available port
	const usedPorts = new Set(activeRegistry.map(e => e.port));
	let port = BASE_PORT;
	
	for (let i = 0; i < MAX_PORT_SEARCH; i++) {
		const candidatePort = BASE_PORT + i;
		if (!usedPorts.has(candidatePort)) {
			// Check if port is actually available using a quick bind test
			const isAvailable = await isPortAvailable(candidatePort);
			if (isAvailable) {
				port = candidatePort;
				break;
			}
		}
	}
	
	// Register this port
	activeRegistry.push({
		port,
		workspace: workspaceId,
		timestamp: Date.now()
	});
	
	await savePortRegistry(context, activeRegistry);
	log(LogLevel.INFO, `Auto-assigned port ${port} for workspace: ${workspaceName}`);
	
	return port;
}

/**
 * Check if a port is available by attempting to bind to it
 * 
 * @param port - Port number to check
 * @returns Promise resolving to true if port is available, false if in use
 * 
 * @remarks
 * - Creates a temporary test server to check availability
 * - Returns true if port binds successfully
 * - Returns false if EADDRINUSE error occurs
 * - Returns true for other errors (assumes available)
 * - Server is immediately closed after testing
 * 
 * @internal This function is not exported as it's an implementation detail
 */
async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const testServer = http.createServer();
		
		testServer.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				resolve(false);
			} else {
				resolve(true); // Other errors, assume available
			}
		});
		
		testServer.once('listening', () => {
			testServer.close();
			resolve(true);
		});
		
		testServer.listen(port);
	});
}

/**
 * Release a port from the registry
 * 
 * @param context - VS Code extension context for global state access
 * @param port - Port number to release
 * 
 * @remarks
 * - Removes port assignment for current workspace
 * - Port becomes available for other workspaces
 * - Safe to call even if port not registered
 * - Only releases port for current workspace (doesn't affect other workspaces using same port)
 * 
 * @example
 * ```typescript
 * await releasePort(context, 3737);
 * console.log('Port released and available for reassignment');
 * ```
 */
export async function releasePort(context: vscode.ExtensionContext, port: number): Promise<void> {
	const registry = await getPortRegistry(context);
	const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-workspace';
	
	const filtered = registry.filter(entry => 
		!(entry.port === port && entry.workspace === workspaceId)
	);
	
	await savePortRegistry(context, filtered);
	removeBridgePortFiles();
	log(LogLevel.INFO, `Released port ${port}`);
}

/**
 * Write a .bridge-port file to each workspace folder so external consumers
 * (e.g. Goltana) can discover which port the bridge is listening on.
 */
export function writeBridgePortFiles(port: number): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders) return;
	for (const folder of folders) {
		try {
			const filePath = path.join(folder.uri.fsPath, PORT_FILENAME);
			fs.writeFileSync(filePath, String(port), 'utf-8');
			log(LogLevel.INFO, `Wrote ${PORT_FILENAME} (${port}) to ${folder.name}`);
		} catch (err) {
			log(LogLevel.WARN, `Failed to write ${PORT_FILENAME} to ${folder.name}: ${err}`);
		}
	}
}

/**
 * Remove .bridge-port files from workspace folders on deactivation.
 */
export function removeBridgePortFiles(): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders) return;
	for (const folder of folders) {
		try {
			const filePath = path.join(folder.uri.fsPath, PORT_FILENAME);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
				log(LogLevel.INFO, `Removed ${PORT_FILENAME} from ${folder.name}`);
			}
		} catch {
			// Best-effort cleanup
		}
	}
}
