/**
 * Webhook Registry — push notifications to external systems.
 * 
 * External systems (e.g., Goltana) register a callback URL.
 * When events occur (response posted, task completed, queue item done),
 * the bridge sends an HTTP POST to all registered URLs.
 */

import { log } from './logging';
import { LogLevel } from './types';
import * as http from 'http';
import * as https from 'https';

export interface WebhookRegistration {
	id: string;
	url: string;
	events: string[];	// e.g. ['response.created', 'task.completed', 'queue.completed']
	registeredAt: string;
}

/** In-memory webhook registry — survives for extension lifetime */
const webhooks: Map<string, WebhookRegistration> = new Map();

/**
 * Register a webhook URL for specific events.
 */
export function registerWebhook(url: string, events: string[]): WebhookRegistration {
	// Deduplicate by URL — update events if same URL re-registers
	for (const [id, existing] of webhooks) {
		if (existing.url === url) {
			existing.events = events;
			log(LogLevel.INFO, `Webhook updated: ${url} → [${events.join(', ')}]`);
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
		return true;
	}
	// Try by URL
	for (const [id, wh] of webhooks) {
		if (wh.url === urlOrId) {
			webhooks.delete(id);
			log(LogLevel.INFO, `Webhook unregistered by URL: ${urlOrId}`);
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
 * Fire a webhook event to all subscribers. Non-blocking, best-effort.
 */
export function fireWebhookEvent(event: string, payload: Record<string, unknown>): void {
	for (const wh of webhooks.values()) {
		if (!wh.events.includes(event) && !wh.events.includes('*')) {
			continue;
		}
		
		const body = JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload });
		
		try {
			const parsedUrl = new URL(wh.url);
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
				// Consume response body to free socket
				res.resume();
				if (res.statusCode && res.statusCode >= 400) {
					log(LogLevel.WARN, `Webhook ${wh.url} returned ${res.statusCode} for event ${event}`);
				}
			});
			req.on('error', (err) => {
				log(LogLevel.WARN, `Webhook delivery failed for ${wh.url}: ${err.message}`);
			});
			req.on('timeout', () => {
				req.destroy();
				log(LogLevel.WARN, `Webhook timed out for ${wh.url}`);
			});
			req.write(body);
			req.end();
		} catch (err) {
			log(LogLevel.WARN, `Webhook fire error for ${wh.url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
