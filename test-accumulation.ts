/**
 * Text accumulation diagnostic test
 */

import { StreamLoopDetector } from './src/agent/StreamLoopDetector.js';
import { ReconstructionCyclePattern } from './src/agent/patterns/loopPatterns.js';
import { ActivityStream } from './src/services/ActivityStream.js';
import { ActivityEventType } from './src/types/index.js';

console.log('='.repeat(70));
console.log('TEXT ACCUMULATION DIAGNOSTIC');
console.log('='.repeat(70));
console.log();

async function test() {
  const activityStream = new ActivityStream();
  const detector = new StreamLoopDetector({
    eventType: ActivityEventType.THOUGHT_CHUNK,
    patterns: [new ReconstructionCyclePattern()],
    warmupPeriodMs: 0,
    checkIntervalMs: 100,
    instanceId: 'test-accumulation',
    onLoopDetected: () => {},
  }, activityStream);

  console.log('Initial state:');
  console.log('  isActive:', detector.isActive());
  console.log('  accumulated:', detector.getAccumulatedLength());
  console.log();

  // Send chunks (detector will auto-start on first chunk)
  console.log('Sending chunk 1...');
  activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'First chunk. ' });
  console.log('After chunk 1:');
  console.log('  isActive:', detector.isActive());
  console.log('  accumulated:', detector.getAccumulatedLength());
  console.log();

  await new Promise(resolve => setTimeout(resolve, 50));

  console.log('Sending chunk 2...');
  activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'Second chunk.' });
  console.log('After chunk 2:');
  console.log('  isActive:', detector.isActive());
  console.log('  accumulated:', detector.getAccumulatedLength());
  console.log();

  detector.stop();

  console.log('After stop:');
  console.log('  isActive:', detector.isActive());
  console.log('  accumulated:', detector.getAccumulatedLength());
}

test().catch(console.error);
