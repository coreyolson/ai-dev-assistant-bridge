/**
 * Tests for AI Queue module
 * 
 * Comprehensive test coverage for the AI communication queue system
 * Consolidated from integration and unit tests
 */

import * as assert from 'assert';
import * as aiQueue from '../src/modules/aiQueue';

// Helper: wraps enqueueInstruction with non-null assert (dedup never fires in tests with unique strings)
function enqueue(...args: Parameters<typeof aiQueue.enqueueInstruction>): aiQueue.QueueInstruction {
	const result = enqueue(...args);
	assert.ok(result, 'enqueueInstruction returned null (unexpected dedup)');
	return result;
}

suite('AI Queue Module Test Suite', () => {
	
	// Reset queue before each test
	setup(() => {
		aiQueue.clearQueue();
		aiQueue.setAutoProcess(false);
	});

	teardown(() => {
		aiQueue.clearQueue();
		aiQueue.setAutoProcess(false);
	});

	suite('Enqueue Operations', () => {
		test('enqueueInstruction should add instruction to queue', () => {
			const instruction = enqueue(
				'Test instruction',
				'test-source',
				'normal'
			);

			assert.strictEqual(instruction.instruction, 'Test instruction');
			assert.strictEqual(instruction.source, 'test-source');
			assert.strictEqual(instruction.priority, 'normal');
			assert.strictEqual(instruction.status, 'pending');
		});

		test('enqueueInstruction should generate unique IDs', () => {
			const inst1 = enqueue('Test 1', 'source1');
			const inst2 = enqueue('Test 2', 'source2');

			assert.notStrictEqual(inst1.id, inst2.id);
		});

		test('enqueueInstruction should handle all priority levels', () => {
			const urgent = enqueue('Urgent', 'src', 'urgent');
			const high = enqueue('High', 'src', 'high');
			const normal = enqueue('Normal', 'src', 'normal');
			const low = enqueue('Low', 'src', 'low');

			assert.strictEqual(urgent.priority, 'urgent');
			assert.strictEqual(high.priority, 'high');
			assert.strictEqual(normal.priority, 'normal');
			assert.strictEqual(low.priority, 'low');
		});

		test('enqueueInstruction should accept metadata', () => {
			const metadata = { project: 'test', userId: '123' };
			const instruction = enqueue(
				'Test',
				'source',
				'normal',
				metadata
			);

			assert.deepStrictEqual(instruction.metadata, metadata);
		});

		test('enqueueInstruction should use default priority if not specified', () => {
			const instruction = enqueue('Test', 'source');
			assert.strictEqual(instruction.priority, 'normal');
		});

		test('enqueueInstruction should reject duplicate instructions within 60s', () => {
			const first = aiQueue.enqueueInstruction('Identical instruction', 'source');
			assert.ok(first, 'First enqueue should succeed');

			const second = aiQueue.enqueueInstruction('Identical instruction', 'source');
			assert.strictEqual(second, null, 'Duplicate within 60s should return null');

			// Different instruction should still work
			const third = aiQueue.enqueueInstruction('Different instruction', 'source');
			assert.ok(third, 'Different instruction should succeed');
		});

		test('enqueueInstruction should store linkedTaskId', () => {
			const inst = enqueue('Test linked', 'source', 'normal', undefined, 'task-123');
			assert.strictEqual(inst.linkedTaskId, 'task-123');
		});
	});

	suite('Queue Retrieval', () => {
		test('getQueue should return all instructions', () => {
			enqueue('Test 1', 'source1');
			enqueue('Test 2', 'source2');

			const queue = aiQueue.getQueue();
			assert.strictEqual(queue.length, 2);
		});

		test('getQueue should filter by status', () => {
			const inst1 = enqueue('Test 1', 'source1');
			const inst2 = enqueue('Test 2', 'source2');

			// Manually set one to completed for testing
			const allQueue = aiQueue.getQueue();
			const found = allQueue.find(i => i.id === inst2.id);
			if (found) {
				found.status = 'completed';
			}

			const pending = aiQueue.getQueue('pending');
			assert.strictEqual(pending.length, 1);
			assert.strictEqual(pending[0].id, inst1.id);
		});

		test('getQueue should return empty array when queue is empty', () => {
			const queue = aiQueue.getQueue();
			assert.strictEqual(queue.length, 0);
		});

		test('getInstruction should return specific instruction by ID', () => {
			const inst = enqueue('Test', 'source');
			const found = aiQueue.getInstruction(inst.id);

			assert.ok(found);
			assert.strictEqual(found.id, inst.id);
		});

		test('getInstruction should return undefined for non-existent ID', () => {
			const found = aiQueue.getInstruction('non-existent-id');
			assert.strictEqual(found, undefined);
		});
	});

	suite('Queue Removal', () => {
		test('removeInstruction should remove instruction by ID', () => {
			const inst = enqueue('Test', 'source');
			const removed = aiQueue.removeInstruction(inst.id);

			assert.strictEqual(removed, true);
			assert.strictEqual(aiQueue.getQueue().length, 0);
		});

		test('removeInstruction should return false for non-existent ID', () => {
			const removed = aiQueue.removeInstruction('non-existent');
			assert.strictEqual(removed, false);
		});

		test('clearProcessed should remove completed and failed instructions', () => {
			const inst1 = enqueue('Test 1', 'source');
			const inst2 = enqueue('Test 2', 'source');
			const inst3 = enqueue('Test 3', 'source');

			// Manually set statuses
			const queue = aiQueue.getQueue();
			queue[0].status = 'completed';
			queue[1].status = 'failed';
			// queue[2] stays 'pending'

			const cleared = aiQueue.clearProcessed();

			assert.strictEqual(cleared, 2);
			assert.strictEqual(aiQueue.getQueue().length, 1);
		});

		test('clearQueue should remove all instructions', () => {
			enqueue('Test 1', 'source');
			enqueue('Test 2', 'source');

			aiQueue.clearQueue();

			assert.strictEqual(aiQueue.getQueue().length, 0);
		});
	});

	suite('Queue Processing', () => {
		test('processNextInstruction should process pending instruction', async () => {
			enqueue('Test', 'source');

			let sentMessage = '';
			const mockSendToAgent = async (message: string) => {
				sentMessage = message;
				return true;
			};

			const processed = await aiQueue.processNextInstruction(mockSendToAgent);

			assert.strictEqual(processed, true);
			assert.strictEqual(sentMessage, 'Test');
		});

		test('processNextInstruction should return false when queue is empty', async () => {
			const mockSendToAgent = async () => true;
			const processed = await aiQueue.processNextInstruction(mockSendToAgent);

			assert.strictEqual(processed, false);
		});

		test('processNextInstruction should keep instruction as processing when sent to agent', async () => {
			const inst = enqueue('Test', 'source');
			const mockSendToAgent = async () => true;

			await aiQueue.processNextInstruction(mockSendToAgent);

			const found = aiQueue.getInstruction(inst.id);
			assert.ok(found);
			assert.strictEqual(found.status, 'processing');
		});

		test('processNextInstruction should mark instruction as failed on error', async () => {
			const inst = enqueue('Test', 'source');
			const mockSendToAgent = async () => false;

			await aiQueue.processNextInstruction(mockSendToAgent);

			const found = aiQueue.getInstruction(inst.id);
			assert.ok(found);
			assert.strictEqual(found.status, 'failed');
		});

		test('processNextInstruction should handle exceptions', async () => {
			const inst = enqueue('Test', 'source');
			const mockSendToAgent = async () => {
				throw new Error('Test error');
			};

			await aiQueue.processNextInstruction(mockSendToAgent);

			const found = aiQueue.getInstruction(inst.id);
			assert.ok(found);
			assert.strictEqual(found.status, 'failed');
			assert.ok(found.error?.includes('Test error'));
		});

		test('processNextInstruction handles non-Error thrown values', async () => {
			const inst = enqueue('test with string error', 'src');
			await aiQueue.processNextInstruction(async () => {
				// eslint-disable-next-line no-throw-literal
				throw 'String error instead of Error object'; // Non-Error throw
			});
			
			const item = aiQueue.getInstruction(inst.id);
			assert.strictEqual(item?.status, 'failed');
			assert.ok(item?.error?.includes('String error'), 'Should convert non-Error to string');
		});

		test('processNextInstruction without sendToAgent should mark as completed', async () => {
			const inst = enqueue('Test', 'source');

			await aiQueue.processNextInstruction();

			const found = aiQueue.getInstruction(inst.id);
			assert.ok(found);
			assert.strictEqual(found.status, 'completed');
		});

		test('processAllInstructions should process multiple instructions', async () => {
			enqueue('Test 1', 'source');
			enqueue('Test 2', 'source');
			enqueue('Test 3', 'source');

			const mockSendToAgent = async () => true;
			const processed = await aiQueue.processAllInstructions(mockSendToAgent);

			assert.strictEqual(processed, 3);
			const completed = aiQueue.getQueue('completed');
			assert.strictEqual(completed.length, 3);
		});

		test('processAllInstructions processes all regardless of failures', async () => {
			enqueue('test1', 'src');
			enqueue('test2', 'src');
			enqueue('test3', 'src');
			
			let callCount = 0;
			const processed = await aiQueue.processAllInstructions(async () => {
				callCount++;
				return callCount !== 2; // Fail on second
			});
			
			// All 3 get processed (returns 3), but statuses differ
			const completed = aiQueue.getQueue('completed');
			const failed = aiQueue.getQueue('failed');
			
			assert.strictEqual(processed, 3, 'Should process all 3');
			assert.strictEqual(completed.length, 2, 'Should have 2 completed');
			assert.strictEqual(failed.length, 1, 'Should have 1 failed');
		});
	});

	suite('Priority Sorting', () => {
		test('Queue should be sorted by priority', () => {
			enqueue('Low', 'source', 'low');
			enqueue('Urgent', 'source', 'urgent');
			enqueue('Normal', 'source', 'normal');
			enqueue('High', 'source', 'high');

			const queue = aiQueue.getQueue();

			assert.strictEqual(queue[0].priority, 'urgent');
			assert.strictEqual(queue[1].priority, 'high');
			assert.strictEqual(queue[2].priority, 'normal');
			assert.strictEqual(queue[3].priority, 'low');
		});

		test('sorts pending status before completed status', async () => {
			// Create multiple items and process some to create a mix
			enqueue('first', 'src', 'urgent');
			enqueue('second', 'src', 'high');
			enqueue('third', 'src', 'normal');
			
			// Process first two to mark them as completed
			await aiQueue.processNextInstruction(async () => true);
			await aiQueue.processNextInstruction(async () => true);
			
			// Now we have: [pending-normal, completed-urgent, completed-high]
			// Add more pending items to force sorting comparisons
			enqueue('fourth', 'src', 'low');
			enqueue('fifth', 'src', 'urgent');
			
			const queue = aiQueue.getQueue();
			
			// All pending items should come before all completed items
			const pendingCount = queue.filter(i => i.status === 'pending').length;
			const completedCount = queue.filter(i => i.status === 'completed').length;
			
			assert.strictEqual(pendingCount, 3, 'Should have 3 pending items');
			assert.strictEqual(completedCount, 2, 'Should have 2 completed items');
			
			// Check that all pending come before all completed
			for (let i = 0; i < pendingCount; i++) {
				assert.strictEqual(queue[i].status, 'pending', `Item ${i} should be pending`);
			}
			for (let i = pendingCount; i < queue.length; i++) {
				assert.strictEqual(queue[i].status, 'completed', `Item ${i} should be completed`);
			}
		});

		test('Pending instructions should come before completed', () => {
			const inst1 = enqueue('First', 'source', 'normal');
			const inst2 = enqueue('Second', 'source', 'normal');

			// Manually set first to completed
			const queue = aiQueue.getQueue();
			queue[0].status = 'completed';

			// Re-enqueue to trigger sort
			enqueue('Third', 'source', 'normal');

			const newQueue = aiQueue.getQueue();
			const pending = newQueue.filter(i => i.status === 'pending');

			assert.strictEqual(pending.length, 2);
		});
	});

	suite('Auto-Process Mode', () => {
		test('setAutoProcess should enable auto-processing', () => {
			aiQueue.setAutoProcess(true);

			const stats = aiQueue.getQueueStats();
			assert.strictEqual(stats.autoProcessEnabled, true);
		});

		test('setAutoProcess should disable auto-processing', () => {
			aiQueue.setAutoProcess(true);
			aiQueue.setAutoProcess(false);

			const stats = aiQueue.getQueueStats();
			assert.strictEqual(stats.autoProcessEnabled, false);
		});

		test('setAutoProcess with callback processes pending items', async function() {
			this.timeout(2000);
			
			enqueue('test', 'src');
			
			let processed = false;
			aiQueue.setAutoProcess(true, async () => {
				processed = true;
				return true;
			});
			
			// Wait for processing
			await new Promise(resolve => setTimeout(resolve, 600));
			
			aiQueue.setAutoProcess(false);
			assert.strictEqual(processed, true);
		});

		test('enqueue should trigger auto-process when enabled', async function() {
			this.timeout(2000);
			
			let processed = false;
			
			// Set up auto-process before enqueuing
			aiQueue.setAutoProcess(true, async () => {
				processed = true;
				return true;
			});
			
			// Small delay to ensure auto-process is set up
			await new Promise(resolve => setTimeout(resolve, 100));
			
			// Enqueue while auto-process is enabled - should trigger immediately
			enqueue('test with auto-process', 'src');
			
			// Wait for processing to complete
			await new Promise(resolve => setTimeout(resolve, 700));
			
			aiQueue.setAutoProcess(false);
			assert.strictEqual(processed, true, 'Auto-process should trigger on enqueue');
		});
	});

	suite('Queue Statistics', () => {
		test('getQueueStats should return accurate counts', () => {
			enqueue('Test 1', 'source');
			enqueue('Test 2', 'source');

			const stats = aiQueue.getQueueStats();

			assert.strictEqual(stats.total, 2);
			assert.strictEqual(stats.pending, 2);
			assert.strictEqual(stats.processing, 0);
			assert.strictEqual(stats.completed, 0);
			assert.strictEqual(stats.failed, 0);
		});

		test('getQueueStats should track different statuses', async () => {
			const inst1 = enqueue('Test 1', 'source');
			const inst2 = enqueue('Test 2', 'source');

			// Process one
			const mockSendToAgent = async () => true;
			await aiQueue.processNextInstruction(mockSendToAgent);

			const stats = aiQueue.getQueueStats();

			assert.strictEqual(stats.total, 2);
			assert.strictEqual(stats.pending, 1);
			assert.strictEqual(stats.completed, 1);
		});

		test('getQueueStats should show empty queue correctly', () => {
			const stats = aiQueue.getQueueStats();

			assert.strictEqual(stats.total, 0);
			assert.strictEqual(stats.pending, 0);
		});
	});

	suite('Context and Metadata', () => {
		test('processNextInstruction should include context in sendToAgent call', async () => {
			const inst = enqueue(
				'Test',
				'test-source',
				'high',
				{ custom: 'data' }
			);

			let receivedContext: any;
			const mockSendToAgent = async (message: string, context?: any) => {
				receivedContext = context;
				return true;
			};

			await aiQueue.processNextInstruction(mockSendToAgent);

			assert.ok(receivedContext);
			assert.strictEqual(receivedContext.source, 'test-source');
			assert.strictEqual(receivedContext.queueId, inst.id);
			assert.strictEqual(receivedContext.priority, 'high');
			assert.deepStrictEqual(receivedContext.metadata, { custom: 'data' });
		});
	});

	suite('Edge Cases', () => {
		test('Should handle empty instruction text', () => {
			const inst = enqueue('', 'source');
			assert.strictEqual(inst.instruction, '');
		});

		test('Should handle very long instruction text', () => {
			const longText = 'a'.repeat(10000);
			const inst = enqueue(longText, 'source');
			assert.strictEqual(inst.instruction.length, 10000);
		});

		test('Should handle special characters in instruction', () => {
			const special = 'Test with\nnewlines\tand\ttabs"quotes"';
			const inst = enqueue(special, 'source');
			assert.strictEqual(inst.instruction, special);
		});

		test('Should handle concurrent processing attempts', async () => {
			enqueue('Test', 'source');

			const mockSendToAgent = async () => {
				// Simulate slow processing
				await new Promise(resolve => setTimeout(resolve, 100));
				return true;
			};

			// Try to process twice simultaneously
			const promise1 = aiQueue.processNextInstruction(mockSendToAgent);
			const promise2 = aiQueue.processNextInstruction(mockSendToAgent);

			const [result1, result2] = await Promise.all([promise1, promise2]);

			// One should succeed, one should fail (already processing)
			assert.ok(result1 || result2);
			assert.ok(!(result1 && result2)); // Both shouldn't succeed
		});

		test('processAllInstructions should stop on first failure', async () => {
			// Enqueue multiple instructions
			enqueue('Success 1', 'source');
			enqueue('Success 2', 'source');
			enqueue('Will fail', 'source');
			enqueue('Never processed', 'source');

			let callCount = 0;
			const mockSendToAgent = async (message: string) => {
				callCount++;
				// Fail on the third call
				if (callCount === 3) {
					return false; // Simulate failure
				}
				return true;
			};

			const processed = await aiQueue.processAllInstructions(mockSendToAgent);

			// Should stop after processing 2 successful and 1 failed
			assert.strictEqual(processed, 2, 'Should only count successful processes');
			assert.strictEqual(callCount, 3, 'Should attempt 3 calls before breaking');
			
			const pending = aiQueue.getQueue('pending');
			assert.strictEqual(pending.length, 2, 'Should have 2 remaining pending items (failed + never processed)');
		});

		test('processAllInstructions should break when processNextInstruction returns false', async () => {
			// Enqueue instructions
			enqueue('Test 1', 'source');
			enqueue('Test 2', 'source');

			let firstCall = true;
			const mockSendToAgent = async () => {
				if (firstCall) {
					firstCall = false;
					// On first call, start another processNextInstruction in parallel
					// This will set processingActive = true
					setTimeout(() => {
						aiQueue.processNextInstruction(async () => true);
					}, 10);
					// Wait a bit to allow the parallel process to start
					await new Promise(resolve => setTimeout(resolve, 50));
				}
				return true;
			};

			const processed = await aiQueue.processAllInstructions(mockSendToAgent);

			// May process 1 or 2 depending on timing, but shouldn't error
			assert.ok(processed >= 1, 'Should process at least 1 instruction');
		});
	});
});
