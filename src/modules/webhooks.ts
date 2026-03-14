/**
 * Webhook Registry — push notifications to external systems.
 * 
 * External systems (e.g., Goltana) register a callback URL.
 * When events occur (response posted, task completed, queue item done),
 * the bridge sends an HTTP POST to all registered URLs.
 * 
 * Registrations are persisted to VS Code globalState so they survive reloads.
 */

import { log } from './logging';
import { LogLevel } from './types';
import * as http from 'http';
import * as https from 'https';
import type * as vscode from 'vscode';

export interface WebhookRegistration {
	id: string;
	url: string;
	events: string[];	// e.g. ['response.created', 'task.completed', 'queue.completed']
	registeredAt: string;
}

export interface DeliveryRecord {
	id: string;
	event: string;
	url: string;
	status: 'success' | 'failed';
	statusCode?: number;
	attempts: number;
	error?: string;
	timestamp: string;
}

const STORAGE_KEY = 'webhookRegistrations';
const DELIVERY_LOG_MAX = 50;
const RETRY_DELAYS = [1000, 2000, 5000]; // Exponential backoff: 1s, 2s, 5s

/** In-memory webhook registry — backed by globalState persistence */
const webhooks: Map<string, WebhookRegistration> = new Map();

/** Ring buffer of recent delivery records */
const deliveryLog: DeliveryRecord[] = [];

/** Extension context for persistence — set via initWebhooks() */
let ctx: vscode.ExtensionContext | undefined;

/**
 * Initialize webhook module with extension context. Restores saved registrations.
 */
export function initWebhooks(context: vscode.ExtensionContext): void {
	ctx = context;
	const saved = context.globalState.get<WebhookRegistration[]>(STORAGE_KEY, []);
	for (const wh of saved) {
		webhooks.set(wh.id, wh);
	}
	if (saved.length > 0) {
		log(LogLevel.INFO, `Restored ${saved.length} webhook registration(s) from storage`);
	}
}

/** Persist current registrations to globalState */
function persist(): void {
	if (!ctx) { return; }
	const list = Array.from(webhooks.values());
	void ctx.globalState.update(STORAGE_KEY, list);
}

/**
 * Register a webhook URL for specific events.
 */
export function registerWebhook(url: string, events: string[]): WebhookRegistration {
	// Deduplicate by URL — update events if same URL re-registers
	for (const [id, existing] of webhooks) {
		if (existing.url === url) {
			existing.events = events;
			log(LogLevel.INFO, `Webhook updated: ${url} → [${events.join(', ')}]`);
			persist();
			return existing;
		}
	}

	const registration: WebhookRegistration = {
		id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		url,
		events,
		registeredAt: new Date().toISOString(),
	};
	webhooks.set(registration.id, registration);
	log(LogLevel.INFO, `Webhook registered: ${url} → [${events.join(', ')}]`);
	persist();
	return registration;
}

/**
 * Unregister a webhook by URL or ID.
 */
export function unregisterWebhook(urlOrId: string): boolean {
	// Try by ID first
	if (webhooks.has(urlOrId)) {
		webhooks.delete(urlOrId);
		log(LogLevel.INFO, `Webhook unregistered by ID: ${urlOrId}`);
		persist();
		return true;
	}
	// Try by URL
	for (const [id, wh] of webhooks) {
		if (wh.url === urlOrId) {
			webhooks.delete(id);
			log(LogLevel.INFO, `Webhook unregistered by URL: ${urlOrId}`);
			persist();
			return true;
		}
	}
	return false;
}

/**
 * List all registered webhooks.
 */
export function listWebhooks(): WebhookRegistration[] {
	return Array.from(webhooks.values());
}

/**
 * Fire a webhook event to all subscribers with retry and delivery tracking.
 */
export function fireWebhookEvent(event: string, payload: Record<string, unknown>): void {
	for (const wh of webhooks.values()) {
		if (!wh.events.includes(event) && !wh.events.includes('*')) {
			continue;
		}
		// Kick off delivery with retries (non-blocking)
		void deliverWithRetry(wh, event, payload, 0);
	}
}

/**
 * Deliver a webhook event with exponential backoff retry.
 */
async function deliverWithRetry(
	wh: WebhookRegistration,
	event: string,
	payload: Record<string, unknown>,
	attempt: number
): Promise<void> {
	const body = JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload });

	try {
		const result = await sendWebhookRequest(wh.url, body);

		if (result.statusCode && result.statusCode >= 400) {
			throw new Error(`HTTP ${result.statusCode}`);
		}

		// Success
		recordDelivery(event, wh.url, 'success', attempt + 1, result.statusCode);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);

		if (attempt < RETRY_DELAYS.length) {
			log(LogLevel.WARN, `Webhook delivery failed for ${wh.url} (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}): ${errorMsg} — retrying in ${RETRY_DELAYS[attempt]}ms`);
			await sleep(RETRY_DELAYS[attempt]);
			return deliverWithRetry(wh, event, payload, attempt + 1);
		}

		// All retries exhausted
		log(LogLevel.ERROR, `Webhook delivery permanently failed for ${wh.url} after ${attempt + 1} attempts: ${errorMsg}`);
		recordDelivery(event, wh.url, 'failed', attempt + 1, undefined, errorMsg);
	}
}

/** Send a single webhook HTTP request. Returns status code. */
function sendWebhookRequest(url: string, body: string): Promise<{ statusCode?: number }> {
	return new Promise((resolve, reject) => {
		try {
			const parsedUrl = new URL(url);
			const isHttps = parsedUrl.protocol === 'https:';
			const options: http.RequestOptions = {
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (isHttps ? 443 : 80),
				path: parsedUrl.pathname,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
				timeout: 5000,
			};

			const req = (isHttps ? https : http).request(options, (res) => {
				res.resume();
				resolve({ statusCode: res.statusCode });
			});
			req.on('error', (err) => reject(err));
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Timeout'));
			});
			req.write(body);
			req.end();
		} catch (err) {
			reject(err);
		}
	});
}

/** Record a delivery attempt in the ring buffer */
function recordDelivery(
	event: string, url: string, status: 'success' | 'failed',
	attempts: number, statusCode?: number, error?: string
): void {
	deliveryLog.push({
		id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		event, url, status, statusCode, attempts, error,
		timestamp: new Date().toISOString(),
	});
	// Trim to ring buffer max
	while (deliveryLog.length > DELIVERY_LOG_MAX) {
		deliveryLog.shift();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get recent delivery records (newest first).
 */
export function getDeliveryLog(): DeliveryRecord[] {
	return [...deliveryLog].reverse();
}
