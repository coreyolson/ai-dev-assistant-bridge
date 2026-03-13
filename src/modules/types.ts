/**
 * Shared type definitions for the AI Dev Assistant Bridge extension
 */

/**
 * Task interface for workspace-specific tasks
 */
export interface Task {
	id: string;
	title: string;
	description: string;
	status: 'pending' | 'in-progress' | 'completed' | 'failed';
	category: 'bug' | 'feature' | 'improvement' | 'documentation' | 'testing' | 'other';
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	summary?: string;
}

/**
 * Custom auto-continue category
 */
export interface CustomCategory {
	id: string;
	name: string;
	emoji?: string;
	message: string;
	interval: number;
	enabled: boolean;
}

/**
 * Logging levels for structured output
 */
export enum LogLevel {
	INFO = 'INFO',
	WARN = 'WARN',
	ERROR = 'ERROR',
	DEBUG = 'DEBUG'
}

/**
 * Extension configuration interface
 */
export interface ExtensionConfig {
	autoContinue: {
		enabled: boolean;
		includeTasks: boolean;
		custom: CustomCategory[];
		categories: {
			[key: string]: {
				enabled: boolean;
				message: string;
				intervalSeconds: number;
			};
		};
	};
	autoApproval: {
		enabled: boolean;
		intervalMs: number;
		autoInject: boolean;
	};
	server: {
		port: number;
	};
}
