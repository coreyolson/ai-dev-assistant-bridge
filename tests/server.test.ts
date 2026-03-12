/**
 * Tests for Server HTTP endpoints
 * 
 * Comprehensive test coverage for REST API endpoints including AI queue
 */

import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import * as server from '../src/modules/server';
import * as aiQueue from '../src/modules/aiQueue';
import * as taskManager from '../src/modules/taskManager';

suite('Server Validation Tests', () => {
	let mockContext: vscode.ExtensionContext;
	let mockSendToAgent: (message: string, context?: unknown) => Promise<boolean>;

	setup(() => {
		// Mock extension context
		mockContext = {
			subscriptions: [],
			globalState: {
				get: () => undefined,
				update: async () => {},
				keys: () => [],
				setKeysForSync: () => {}
			},
			workspaceState: {
				get: () => undefined,
				update: async () => {},
				keys: () => []
			}
		} as any;

		// Mock send to agent function
		mockSendToAgent = async (message: string) => {
			return true;
		};
	});

	test('startServer should reject invalid port number (too low)', () => {
		assert.throws(
			() => server.startServer(mockContext, 500, mockSendToAgent),
			/Invalid port number.*Must be between 1024 and 65535/,
			'Should throw error for port < 1024'
		);
	});

	test('startServer should reject invalid port number (too high)', () => {
		assert.throws(
			() => server.startServer(mockContext, 70000, mockSendToAgent),
			/Invalid port number.*Must be between 1024 and 65535/,
			'Should throw error for port > 65535'
		);
	});

	test('startServer should reject invalid port number (negative)', () => {
		assert.throws(
			() => server.startServer(mockContext, -1, mockSendToAgent),
			/Invalid port number.*Must be between 1024 and 65535/,
			'Should throw error for negative port'
		);
	});
});

suite('Server HTTP Endpoints Test Suite', () => {
	let testServer: http.Server;
	let testPort: number;
	let mockContext: vscode.ExtensionContext;
	let mockSendToAgent: (message: string, context?: unknown) => Promise<boolean>;

	// Setup before tests
	suiteSetup(() => {
		// Mock extension context
		mockContext = {
			subscriptions: [],
			globalState: {
				get: () => undefined,
				update: async () => {},
				keys: () => [],
				setKeysForSync: () => {}
			},
			workspaceState: {
				get: () => undefined,
				update: async () => {},
				keys: () => []
			}
		} as any;

		// Mock send to agent function
		mockSendToAgent = async (message: string) => {
			return true;
		};

		// Find available port and start server
		testPort = 3800 + Math.floor(Math.random() * 100);
		testServer = server.startServer(mockContext, testPort, mockSendToAgent);
	});

	suiteTeardown((done) => {
		// Clean up server
		if (testServer) {
			testServer.close(() => done());
		} else {
			done();
		}
	});

	// Clear AI queue before each test
	setup(() => {
		aiQueue.clearQueue();
	});

	suite('Health Check Endpoints', () => {
		test('GET / should return API documentation', (done) => {
			http.get(`http://localhost:${testPort}/`, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					assert.ok(data.includes('AI Dev Assistant Bridge'));
					assert.ok(data.includes('API Documentation'));
					done();
				});
			}).on('error', done);
		});

		test('GET /help should return API documentation', (done) => {
			http.get(`http://localhost:${testPort}/help`, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					assert.ok(data.includes('API Documentation'));
					done();
				});
			}).on('error', done);
		});
	});

	suite('AI Queue Endpoints', () => {
		test('GET /ai/queue should return empty queue initially', (done) => {
			http.get(`http://localhost:${testPort}/ai/queue`, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(Array.isArray(response.queue));
					assert.strictEqual(response.count, 0);
					done();
				});
			}).on('error', done);
		});

		test('POST /ai/queue should enqueue instruction', (done) => {
			const payload = JSON.stringify({
				instruction: 'Test instruction from API',
				source: 'test-api',
				priority: 'high',
				metadata: { test: true }
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 201);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					assert.ok(response.queueItem);
					assert.strictEqual(response.queueItem.instruction, 'Test instruction from API');
					assert.strictEqual(response.queueItem.priority, 'high');
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /ai/queue should reject missing instruction', (done) => {
			const payload = JSON.stringify({
				source: 'test-api'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('GET /ai/queue/stats should return queue statistics', (done) => {
			// Enqueue some test items
			aiQueue.enqueueInstruction('Test 1', 'test', 'normal');
			aiQueue.enqueueInstruction('Test 2', 'test', 'high');

			http.get(`http://localhost:${testPort}/ai/queue/stats`, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const stats = JSON.parse(data);
					assert.strictEqual(stats.total, 2);
					assert.strictEqual(stats.pending, 2);
					assert.strictEqual(stats.processing, 0);
					assert.strictEqual(stats.completed, 0);
					done();
				});
			}).on('error', done);
		});

		test('POST /ai/queue/process should process next instruction', (done) => {
			// Enqueue test instruction
			aiQueue.enqueueInstruction('Test instruction', 'test', 'normal');

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue/process',
				method: 'POST'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('POST /ai/queue/process should return false when queue empty', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue/process',
				method: 'POST'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, false);
					assert.ok(response.message.includes('No pending'));
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('DELETE /ai/queue/:id should remove instruction', (done) => {
			// Enqueue test instruction
			const inst = aiQueue.enqueueInstruction('Test instruction', 'test', 'normal');
			assert.ok(inst, 'enqueueInstruction returned null');

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: `/ai/queue/${inst.id}`,
				method: 'DELETE'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					
					// Verify it's removed
					const remaining = aiQueue.getQueue();
					assert.strictEqual(remaining.length, 0);
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('DELETE /ai/queue/:id should return 404 for non-existent ID', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue/non-existent-id',
				method: 'DELETE'
			}, (res) => {
				assert.strictEqual(res.statusCode, 404);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('POST /ai/queue/clear should clear processed instructions', (done) => {
			// Enqueue and process instructions
			const inst1 = aiQueue.enqueueInstruction('Test 1', 'test');
			const inst2 = aiQueue.enqueueInstruction('Test 2', 'test');
			
			// Manually mark as completed
			const queue = aiQueue.getQueue();
			queue[0].status = 'completed';

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue/clear',
				method: 'POST'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					assert.ok(response.message.includes('Cleared'));
					
					// Should only have pending items left
					const remaining = aiQueue.getQueue();
					assert.strictEqual(remaining.length, 1);
					assert.strictEqual(remaining[0].status, 'pending');
					done();
				});
			});

			req.on('error', done);
			req.end();
		});
	});

	suite('Task Endpoints', () => {
		test('GET /tasks should return tasks array', (done) => {
			http.get(`http://localhost:${testPort}/tasks`, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const tasks = JSON.parse(data);
					assert.ok(Array.isArray(tasks));
					done();
				});
			}).on('error', done);
		});

		test('POST /tasks should create new task', (done) => {
			const payload = JSON.stringify({
				title: 'Test task from API',
				description: 'Test description',
				category: 'feature'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 201);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const task = JSON.parse(data);
					assert.strictEqual(task.title, 'Test task from API');
					assert.strictEqual(task.category, 'feature');
					assert.ok(task.id);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /tasks should reject empty title', (done) => {
			const payload = JSON.stringify({
				title: '',
				category: 'feature'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /tasks should reject whitespace-only title', (done) => {
			const payload = JSON.stringify({
				title: '   ',
				category: 'feature'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.error.includes('empty'));
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /tasks should reject title over 200 chars', (done) => {
			const payload = JSON.stringify({
				title: 'a'.repeat(201),
				category: 'feature'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.error.includes('too long'));
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /tasks should reject description over 5000 chars', (done) => {
			const payload = JSON.stringify({
				title: 'Valid Title',
				description: 'a'.repeat(5001),
				category: 'feature'
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.error.includes('Description too long'));
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /tasks should handle invalid JSON', (done) => {
			const payload = 'invalid json{';

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('PUT /tasks/:id should update task status', (done) => {
			// First create a task
			const createPayload = JSON.stringify({ title: 'Task to update' });
			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Now update it
					const updatePayload = JSON.stringify({ status: 'completed' });
					const updateReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(updatePayload)
						}
					}, (updateRes) => {
						assert.strictEqual(updateRes.statusCode, 200);
						done();
					});
					
					updateReq.on('error', done);
					updateReq.write(updatePayload);
					updateReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});

		test('DELETE /tasks/:id should remove task', (done) => {
			// First create a task
			const createPayload = JSON.stringify({ title: 'Task to delete' });
			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Now delete it
					const deleteReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'DELETE'
					}, (deleteRes) => {
						assert.strictEqual(deleteRes.statusCode, 200);
						done();
					});
					
					deleteReq.on('error', done);
					deleteReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});

		test('PATCH /tasks/:id should update task status', (done) => {
			// First create a task
			const createPayload = JSON.stringify({
				title: 'Test Task for PATCH',
				category: 'bug'
			});

			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Now update its status
					const updatePayload = JSON.stringify({ status: 'in-progress' });
					const patchReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'PATCH',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(updatePayload)
						}
					}, (patchRes) => {
						assert.strictEqual(patchRes.statusCode, 200);
						
						let patchData = '';
						patchRes.on('data', chunk => patchData += chunk);
						patchRes.on('end', () => {
							const updatedTask = JSON.parse(patchData);
							assert.strictEqual(updatedTask.status, 'in-progress');
							done();
						});
					});
					
					patchReq.on('error', done);
					patchReq.write(updatePayload);
					patchReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});

		test('PATCH /tasks/:id should reject invalid status', (done) => {
			// First create a task
			const createPayload = JSON.stringify({
				title: 'Test Task for Invalid Status',
				category: 'bug'
			});

			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Try to update with invalid status
					const updatePayload = JSON.stringify({ status: 'invalid-status' });
					const patchReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'PATCH',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(updatePayload)
						}
					}, (patchRes) => {
						assert.strictEqual(patchRes.statusCode, 400);
						
						let patchData = '';
						patchRes.on('data', chunk => patchData += chunk);
						patchRes.on('end', () => {
							const response = JSON.parse(patchData);
							assert.ok(response.error);
							assert.ok(response.error.includes('status'));
							done();
						});
					});
					
					patchReq.on('error', done);
					patchReq.write(updatePayload);
					patchReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});

		test('PATCH /tasks/:id should reject missing status', (done) => {
			// First create a task
			const createPayload = JSON.stringify({
				title: 'Test Task for Missing Status',
				category: 'bug'
			});

			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Try to update without status field
					const updatePayload = JSON.stringify({ otherField: 'value' });
					const patchReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'PATCH',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(updatePayload)
						}
					}, (patchRes) => {
						assert.strictEqual(patchRes.statusCode, 400);
						
						let patchData = '';
						patchRes.on('data', chunk => patchData += chunk);
						patchRes.on('end', () => {
							const response = JSON.parse(patchData);
							assert.ok(response.error);
							done();
						});
					});
					
					patchReq.on('error', done);
					patchReq.write(updatePayload);
					patchReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});

		test('PATCH /tasks/:id should handle invalid JSON', (done) => {
			// First create a task
			const createPayload = JSON.stringify({
				title: 'Test Task for Invalid JSON',
				category: 'bug'
			});

			const createReq = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(createPayload)
				}
			}, (createRes) => {
				let data = '';
				createRes.on('data', chunk => data += chunk);
				createRes.on('end', () => {
					const task = JSON.parse(data);
					
					// Send invalid JSON
					const invalidPayload = 'not-valid-json{';
					const patchReq = http.request({
						hostname: 'localhost',
						port: testPort,
						path: `/tasks/${task.id}`,
						method: 'PATCH',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(invalidPayload)
						}
					}, (patchRes) => {
						assert.strictEqual(patchRes.statusCode, 400);
						
						let patchData = '';
						patchRes.on('data', chunk => patchData += chunk);
						patchRes.on('end', () => {
							const response = JSON.parse(patchData);
							assert.ok(response.error);
							assert.ok(response.error.includes('JSON'));
							done();
						});
					});
					
					patchReq.on('error', done);
					patchReq.write(invalidPayload);
					patchReq.end();
				});
			});
			
			createReq.on('error', done);
			createReq.write(createPayload);
			createReq.end();
		});
	});

	suite('Feedback Endpoint', () => {
		test('POST /feedback should accept valid feedback', (done) => {
			const payload = JSON.stringify({
				message: 'Test feedback message',
				context: { test: true }
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /feedback should reject empty message', (done) => {
			const payload = JSON.stringify({
				message: ''
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /feedback should reject whitespace-only message', (done) => {
			const payload = JSON.stringify({
				message: '   \n\t   '
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.error.includes('empty'));
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /feedback should reject message over 50000 chars', (done) => {
			const payload = JSON.stringify({
				message: 'a'.repeat(50001)
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.error.includes('too long'));
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});

		test('POST /feedback should reject missing message field', (done) => {
			const payload = JSON.stringify({
				context: { test: true }
			});

			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					done();
				});
			});

			req.on('error', done);
			req.write(payload);
			req.end();
		});
	});

	suite('Error Handling', () => {
		test('GET /unknown-endpoint should return 404', (done) => {
			http.get(`http://localhost:${testPort}/unknown-endpoint`, (res) => {
				assert.strictEqual(res.statusCode, 404);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.ok(response.error);
					assert.ok(response.message.includes('Unknown endpoint'));
					done();
				});
			}).on('error', done);
		});

		test('POST /restart-app should accept restart request', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/restart-app',
				method: 'POST'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					assert.ok(response.message.includes('restart'));
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('GET /restart-app with delay parameter', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/restart-app?delay=5',
				method: 'GET'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					const response = JSON.parse(data);
					assert.strictEqual(response.success, true);
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('OPTIONS request should return 200 with CORS headers', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/ai/queue',
				method: 'OPTIONS'
			}, (res) => {
				assert.strictEqual(res.statusCode, 200);
				assert.ok(res.headers['access-control-allow-origin']);
				assert.ok(res.headers['access-control-allow-methods']);
				done();
			});

			req.on('error', done);
			req.end();
		});
	});

	suite('HTTP Error Responses', () => {
		test('should return 404 for unknown endpoint (line 274)', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/unknown-endpoint',
				method: 'GET'
			}, (res) => {
				assert.strictEqual(res.statusCode, 404);
				
				let data = '';
				res.on('data', chunk => { data += chunk; });
				res.on('end', () => {
					const json = JSON.parse(data);
					assert.strictEqual(json.error, 'Not found');
					assert.ok(json.message.includes('Unknown endpoint'));
					done();
				});
			});

			req.on('error', done);
			req.end();
		});

		test('should return 404 for wrong HTTP method on existing path', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/tasks',
				method: 'PUT' // tasks endpoint doesn't support PUT at root
			}, (res) => {
				assert.strictEqual(res.statusCode, 404);
				done();
			});

			req.on('error', done);
			req.end();
		});

		test('should return 400 for invalid JSON in POST /feedback', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => { data += chunk; });
				res.on('end', () => {
					const json = JSON.parse(data);
					assert.ok(json.error);
					done();
				});
			});

			req.on('error', done);
			req.write('invalid json{');
			req.end();
		});

		test('should return 400 for missing message in POST /feedback', (done) => {
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				}
			}, (res) => {
				assert.strictEqual(res.statusCode, 400);
				
				let data = '';
				res.on('data', chunk => { data += chunk; });
				res.on('end', () => {
					const json = JSON.parse(data);
					assert.ok(json.error);
					done();
				});
			});

			req.on('error', done);
			req.write(JSON.stringify({ noMessageField: 'test' }));
			req.end();
		});

		test('should handle request body exceeding 1MB limit', (done) => {
			const largePayload = 'x'.repeat(2 * 1024 * 1024); // 2MB
			const req = http.request({
				hostname: 'localhost',
				port: testPort,
				path: '/feedback',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(largePayload)
				}
			}, (res) => {
				// Should get 413 Payload Too Large or connection closed
				if (res.statusCode) {
					assert.ok(res.statusCode === 413 || res.statusCode >= 400);
				}
				done();
			});

			req.on('error', () => {
				// Connection might be closed, which is also acceptable
				done();
			});
			
			req.write(largePayload);
			req.end();
		});
	});
});
