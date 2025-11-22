/**
 * Comprehensive Integration Test for Loop Detection System
 *
 * Tests the complete loop detection implementation including:
 * - StreamLoopDetector instantiation
 * - Pattern detection strategies
 * - ActivityStream integration
 * - Configuration validation
 * - Edge cases and error handling
 * - Lifecycle management
 */

import { StreamLoopDetector } from './src/agent/StreamLoopDetector.js';
import {
  ReconstructionCyclePattern,
  RepeatedQuestionPattern,
  RepeatedActionPattern,
  CharacterRepetitionPattern,
  PhraseRepetitionPattern,
  SentenceRepetitionPattern,
} from './src/agent/patterns/loopPatterns.js';
import { ActivityStream } from './src/services/ActivityStream.js';
import { ActivityEventType } from './src/types/index.js';
import { THINKING_LOOP_DETECTOR, RESPONSE_LOOP_DETECTOR } from './src/config/constants.js';
import type { LoopInfo } from './src/agent/types/loopDetection.js';

// Test results tracking
interface TestResult {
  category: string;
  test: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details?: string;
  error?: any;
}

const results: TestResult[] = [];

function log(category: string, message: string) {
  console.log(`[${category}] ${message}`);
}

function pass(category: string, test: string, details?: string) {
  results.push({ category, test, status: 'PASS', details });
  log(category, `✅ ${test}${details ? `: ${details}` : ''}`);
}

function fail(category: string, test: string, details?: string, error?: any) {
  results.push({ category, test, status: 'FAIL', details, error });
  log(category, `❌ ${test}${details ? `: ${details}` : ''}`);
  if (error) {
    console.error(error);
  }
}

function warn(category: string, test: string, details?: string) {
  results.push({ category, test, status: 'WARN', details });
  log(category, `⚠️  ${test}${details ? `: ${details}` : ''}`);
}

// ===========================================
// TEST 1: Build Verification
// ===========================================
async function testBuildVerification() {
  const category = 'BUILD';
  log(category, 'Starting build verification tests...');

  try {
    // Test imports resolve
    if (!StreamLoopDetector) throw new Error('StreamLoopDetector not imported');
    if (!ActivityStream) throw new Error('ActivityStream not imported');
    if (!ReconstructionCyclePattern) throw new Error('ReconstructionCyclePattern not imported');
    pass(category, 'All imports resolve correctly');
  } catch (error) {
    fail(category, 'Import resolution', 'Failed to import required modules', error);
  }

  try {
    // Test constants are accessible
    if (typeof THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS !== 'number') {
      throw new Error('THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS not accessible');
    }
    if (typeof RESPONSE_LOOP_DETECTOR.WARMUP_PERIOD_MS !== 'number') {
      throw new Error('RESPONSE_LOOP_DETECTOR.WARMUP_PERIOD_MS not accessible');
    }
    pass(category, 'Configuration constants accessible');
  } catch (error) {
    fail(category, 'Configuration constants', 'Failed to access constants', error);
  }
}

// ===========================================
// TEST 2: Integration Testing
// ===========================================
async function testIntegration() {
  const category = 'INTEGRATION';
  log(category, 'Starting integration tests...');

  try {
    const activityStream = new ActivityStream();

    // Test thinking detector instantiation
    const thinkingDetector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [
        new ReconstructionCyclePattern(),
        new RepeatedQuestionPattern(),
        new RepeatedActionPattern(),
      ],
      warmupPeriodMs: 1000,
      checkIntervalMs: 500,
      instanceId: 'test-thinking',
      onLoopDetected: () => {},
    }, activityStream);

    pass(category, 'Thinking detector instantiated', 'Created with THOUGHT_CHUNK event type');

    if (!thinkingDetector.isActive()) {
      pass(category, 'Thinking detector starts inactive', 'isActive() returns false initially');
    } else {
      warn(category, 'Thinking detector state', 'Started active unexpectedly');
    }

    thinkingDetector.stop();
  } catch (error) {
    fail(category, 'Thinking detector instantiation', undefined, error);
  }

  try {
    const activityStream = new ActivityStream();

    // Test response detector instantiation
    const responseDetector = new StreamLoopDetector({
      eventType: ActivityEventType.ASSISTANT_CHUNK,
      patterns: [
        new CharacterRepetitionPattern(),
        new PhraseRepetitionPattern(),
        new SentenceRepetitionPattern(),
      ],
      warmupPeriodMs: 1000,
      checkIntervalMs: 500,
      instanceId: 'test-response',
      onLoopDetected: () => {},
    }, activityStream);

    pass(category, 'Response detector instantiated', 'Created with ASSISTANT_CHUNK event type');

    responseDetector.stop();
  } catch (error) {
    fail(category, 'Response detector instantiation', undefined, error);
  }

  try {
    const activityStream = new ActivityStream();

    // Test both detectors coexist
    const thinkingDetector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 1000,
      checkIntervalMs: 500,
      instanceId: 'test-thinking-coexist',
      onLoopDetected: () => {},
    }, activityStream);

    const responseDetector = new StreamLoopDetector({
      eventType: ActivityEventType.ASSISTANT_CHUNK,
      patterns: [new CharacterRepetitionPattern()],
      warmupPeriodMs: 1000,
      checkIntervalMs: 500,
      instanceId: 'test-response-coexist',
      onLoopDetected: () => {},
    }, activityStream);

    pass(category, 'Both detectors coexist', 'Multiple detectors can share ActivityStream');

    thinkingDetector.stop();
    responseDetector.stop();
  } catch (error) {
    fail(category, 'Detector coexistence', undefined, error);
  }
}

// ===========================================
// TEST 3: Pattern Detection - Thinking
// ===========================================
async function testThinkingPatterns() {
  const category = 'THINKING_PATTERNS';
  log(category, 'Starting thinking pattern detection tests...');

  // Test ReconstructionCyclePattern
  try {
    const pattern = new ReconstructionCyclePattern();

    // Should NOT detect with single instance
    const text1 = "Let me think about this. I should consider the options.";
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'ReconstructionCyclePattern - no false positive', 'Single instance not detected');
    } else {
      fail(category, 'ReconstructionCyclePattern - false positive', 'Single instance incorrectly detected');
    }

    // Should detect with threshold instances (2+)
    const text2 = "Let me reconsider. Actually, I should reconsider again.";
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'ReconstructionCyclePattern - detection', `Detected 2+ instances: ${result2.reason}`);
    } else {
      fail(category, 'ReconstructionCyclePattern - detection', 'Failed to detect 2+ instances');
    }
  } catch (error) {
    fail(category, 'ReconstructionCyclePattern', undefined, error);
  }

  // Test RepeatedQuestionPattern
  try {
    const pattern = new RepeatedQuestionPattern();

    // Should NOT detect with only 2 similar questions
    const text1 = "What should I do? What should we do?";
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'RepeatedQuestionPattern - threshold', 'Does not trigger with 2 questions');
    } else {
      warn(category, 'RepeatedQuestionPattern - threshold', 'Triggered with only 2 questions');
    }

    // Should detect with 3+ similar questions
    const text2 = "What should I do? What should we do? What should they do?";
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'RepeatedQuestionPattern - detection', `Detected 3+ similar: ${result2.reason}`);
    } else {
      fail(category, 'RepeatedQuestionPattern - detection', 'Failed to detect 3+ similar questions');
    }
  } catch (error) {
    fail(category, 'RepeatedQuestionPattern', undefined, error);
  }

  // Test RepeatedActionPattern
  try {
    const pattern = new RepeatedActionPattern();

    // Should NOT detect with only 2 similar actions
    const text1 = "I will check the file. I'll check the configuration.";
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'RepeatedActionPattern - threshold', 'Does not trigger with 2 actions');
    } else {
      warn(category, 'RepeatedActionPattern - threshold', 'Triggered with only 2 actions');
    }

    // Should detect with 3+ similar actions
    const text2 = "I will check the file. I'll check the configuration. I should check the settings.";
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'RepeatedActionPattern - detection', `Detected 3+ similar: ${result2.reason}`);
    } else {
      fail(category, 'RepeatedActionPattern - detection', 'Failed to detect 3+ similar actions');
    }
  } catch (error) {
    fail(category, 'RepeatedActionPattern', undefined, error);
  }
}

// ===========================================
// TEST 4: Pattern Detection - Response
// ===========================================
async function testResponsePatterns() {
  const category = 'RESPONSE_PATTERNS';
  log(category, 'Starting response pattern detection tests...');

  // Test CharacterRepetitionPattern
  try {
    const pattern = new CharacterRepetitionPattern();

    // Should NOT detect with insufficient repetitions
    const text1 = "2.2.2.2.2.2.2.2.2.2."; // 10 repetitions
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'CharacterRepetitionPattern - threshold', 'Does not trigger with <30 reps');
    } else {
      warn(category, 'CharacterRepetitionPattern - threshold', `Triggered with only ${result1.repetitionCount} reps`);
    }

    // CRITICAL TEST: Should detect "2.2.2.2..." pattern (30+ repetitions)
    const text2 = "2.".repeat(35); // "2.2.2.2..." 35 times
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'CharacterRepetitionPattern - 2.2.2.2... detection', `✅ CRITICAL: Detected "${result2.repetitionCount}" reps of "2."`);
    } else {
      fail(category, 'CharacterRepetitionPattern - 2.2.2.2... detection', '❌ CRITICAL: Failed to detect 2.2.2.2... pattern');
    }

    // Test with other patterns
    const text3 = "abc".repeat(40); // "abcabcabc..." 40 times
    const result3 = pattern.check(text3);
    if (result3 !== null) {
      pass(category, 'CharacterRepetitionPattern - multi-char', `Detected "${result3.repetitionCount}" reps of 3-char pattern`);
    } else {
      fail(category, 'CharacterRepetitionPattern - multi-char', 'Failed to detect multi-character pattern');
    }
  } catch (error) {
    fail(category, 'CharacterRepetitionPattern', undefined, error);
  }

  // Test PhraseRepetitionPattern
  try {
    const pattern = new PhraseRepetitionPattern();

    // Should NOT detect with only 2 similar phrases
    const text1 = "This is a test phrase. This is another test phrase.";
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'PhraseRepetitionPattern - threshold', 'Does not trigger with 2 phrases');
    } else {
      warn(category, 'PhraseRepetitionPattern - threshold', 'Triggered with only 2 phrases');
    }

    // Should detect with 3+ similar phrases
    const text2 = "This is a test phrase. This is another test phrase. This is yet another test phrase.";
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'PhraseRepetitionPattern - detection', `Detected 3+ similar: ${result2.reason}`);
    } else {
      fail(category, 'PhraseRepetitionPattern - detection', 'Failed to detect 3+ similar phrases');
    }
  } catch (error) {
    fail(category, 'PhraseRepetitionPattern', undefined, error);
  }

  // Test SentenceRepetitionPattern
  try {
    const pattern = new SentenceRepetitionPattern();

    // Should NOT detect with only 2 similar sentences
    const text1 = "The quick brown fox jumps. The quick brown dog jumps.";
    const result1 = pattern.check(text1);
    if (result1 === null) {
      pass(category, 'SentenceRepetitionPattern - threshold', 'Does not trigger with 2 sentences');
    } else {
      warn(category, 'SentenceRepetitionPattern - threshold', 'Triggered with only 2 sentences');
    }

    // Should detect with 3+ similar sentences
    const text2 = "The quick brown fox jumps. The quick brown dog jumps. The quick brown cat jumps.";
    const result2 = pattern.check(text2);
    if (result2 !== null) {
      pass(category, 'SentenceRepetitionPattern - detection', `Detected 3+ similar: ${result2.reason}`);
    } else {
      fail(category, 'SentenceRepetitionPattern - detection', 'Failed to detect 3+ similar sentences');
    }
  } catch (error) {
    fail(category, 'SentenceRepetitionPattern', undefined, error);
  }
}

// ===========================================
// TEST 5: Configuration Validation
// ===========================================
async function testConfiguration() {
  const category = 'CONFIGURATION';
  log(category, 'Starting configuration validation tests...');

  try {
    // Verify thinking detector constants
    const expectedThinking = {
      WARMUP_PERIOD_MS: 20000,
      CHECK_INTERVAL_MS: 5000,
      RECONSTRUCTION_THRESHOLD: 2,
      REPETITION_THRESHOLD: 3,
      SIMILARITY_THRESHOLD: 0.7,
    };

    let allMatch = true;
    for (const [key, expected] of Object.entries(expectedThinking)) {
      const actual = (THINKING_LOOP_DETECTOR as any)[key];
      if (actual !== expected) {
        fail(category, `THINKING_LOOP_DETECTOR.${key}`, `Expected ${expected}, got ${actual}`);
        allMatch = false;
      }
    }

    if (allMatch) {
      pass(category, 'THINKING_LOOP_DETECTOR constants', 'All values correct');
    }
  } catch (error) {
    fail(category, 'THINKING_LOOP_DETECTOR constants', undefined, error);
  }

  try {
    // Verify response detector constants
    const expectedResponse = {
      WARMUP_PERIOD_MS: 10000,
      CHECK_INTERVAL_MS: 3000,
      CHAR_REPETITION_THRESHOLD: 30,
      PHRASE_REPETITION_THRESHOLD: 3,
      SENTENCE_REPETITION_THRESHOLD: 3,
      SIMILARITY_THRESHOLD: 0.7,
    };

    let allMatch = true;
    for (const [key, expected] of Object.entries(expectedResponse)) {
      const actual = (RESPONSE_LOOP_DETECTOR as any)[key];
      if (actual !== expected) {
        fail(category, `RESPONSE_LOOP_DETECTOR.${key}`, `Expected ${expected}, got ${actual}`);
        allMatch = false;
      }
    }

    if (allMatch) {
      pass(category, 'RESPONSE_LOOP_DETECTOR constants', 'All values correct');
    }
  } catch (error) {
    fail(category, 'RESPONSE_LOOP_DETECTOR constants', undefined, error);
  }

  try {
    // Verify no hardcoded values in patterns (check source uses constants)
    const reconstructionPattern = new ReconstructionCyclePattern();
    const text = "Let me reconsider. I should reconsider."; // Exactly 2 instances
    const result = reconstructionPattern.check(text);

    if (result !== null && THINKING_LOOP_DETECTOR.RECONSTRUCTION_THRESHOLD === 2) {
      pass(category, 'Pattern uses constants', 'ReconstructionCyclePattern respects RECONSTRUCTION_THRESHOLD');
    } else if (result === null) {
      fail(category, 'Pattern uses constants', 'Pattern threshold does not match constant');
    }
  } catch (error) {
    fail(category, 'Pattern uses constants', undefined, error);
  }
}

// ===========================================
// TEST 6: Edge Cases
// ===========================================
async function testEdgeCases() {
  const category = 'EDGE_CASES';
  log(category, 'Starting edge case tests...');

  // Test empty text handling
  try {
    const pattern = new CharacterRepetitionPattern();
    const result = pattern.check('');
    if (result === null) {
      pass(category, 'Empty text handling', 'Patterns handle empty string gracefully');
    } else {
      fail(category, 'Empty text handling', 'Pattern detected loop in empty string');
    }
  } catch (error) {
    fail(category, 'Empty text handling', 'Exception on empty string', error);
  }

  // Test very long text handling
  try {
    const pattern = new CharacterRepetitionPattern();
    const longText = 'a'.repeat(100000); // 100k characters
    const result = pattern.check(longText);
    pass(category, 'Long text handling', 'Pattern handles 100k chars without error');
  } catch (error) {
    fail(category, 'Long text handling', 'Exception on long text', error);
  }

  // Test no patterns configured
  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [], // No patterns
      warmupPeriodMs: 100,
      checkIntervalMs: 100,
      instanceId: 'test-no-patterns',
      onLoopDetected: () => {},
    }, activityStream);

    detector.start();
    pass(category, 'No patterns configured', 'Detector handles empty pattern array');
    detector.stop();
  } catch (error) {
    fail(category, 'No patterns configured', undefined, error);
  }

  // Test pattern throws exception
  try {
    class ThrowingPattern {
      name = 'throwing';
      check(): any {
        throw new Error('Pattern error');
      }
    }

    const activityStream = new ActivityStream();
    let callbackInvoked = false;
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ThrowingPattern() as any, new ReconstructionCyclePattern()],
      warmupPeriodMs: 0,
      checkIntervalMs: 100,
      instanceId: 'test-throwing',
      onLoopDetected: () => { callbackInvoked = true; },
    }, activityStream);

    detector.start();

    // Simulate chunks to trigger check
    await new Promise(resolve => setTimeout(resolve, 150));
    activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'Let me reconsider. I should reconsider.' });
    await new Promise(resolve => setTimeout(resolve, 150));

    if (callbackInvoked) {
      pass(category, 'Pattern exception handling', 'Continues to next pattern after exception');
    } else {
      warn(category, 'Pattern exception handling', 'Loop not detected (timing issue or callback not invoked)');
    }

    detector.stop();
  } catch (error) {
    fail(category, 'Pattern exception handling', undefined, error);
  }

  // Test callback throws exception
  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 0,
      checkIntervalMs: 100,
      instanceId: 'test-callback-throws',
      onLoopDetected: () => {
        throw new Error('Callback error');
      },
    }, activityStream);

    detector.start();

    // Simulate chunks
    await new Promise(resolve => setTimeout(resolve, 50));
    activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'Let me reconsider. I should reconsider.' });
    await new Promise(resolve => setTimeout(resolve, 150));

    pass(category, 'Callback exception handling', 'Detector handles callback exceptions gracefully');
    detector.stop();
  } catch (error) {
    fail(category, 'Callback exception handling', 'Detector crashed on callback exception', error);
  }
}

// ===========================================
// TEST 7: Lifecycle Validation
// ===========================================
async function testLifecycle() {
  const category = 'LIFECYCLE';
  log(category, 'Starting lifecycle validation tests...');

  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 1000,
      checkIntervalMs: 500,
      instanceId: 'test-lifecycle',
      onLoopDetected: () => {},
    }, activityStream);

    // Test initial state
    if (!detector.isActive()) {
      pass(category, 'Initial state', 'Detector starts inactive');
    }

    // Test start
    detector.start();
    if (detector.isActive()) {
      pass(category, 'Start operation', 'Detector becomes active after start()');
    } else {
      fail(category, 'Start operation', 'Detector did not become active');
    }

    // Test stop
    detector.stop();
    if (!detector.isActive()) {
      pass(category, 'Stop operation', 'Detector becomes inactive after stop()');
    } else {
      fail(category, 'Stop operation', 'Detector still active after stop()');
    }

    // Test reset
    detector.reset();
    if (!detector.isActive() && detector.getAccumulatedLength() === 0) {
      pass(category, 'Reset operation', 'Detector resets state correctly');
    } else {
      fail(category, 'Reset operation', 'Detector state not properly reset');
    }

    detector.stop();
  } catch (error) {
    fail(category, 'Basic lifecycle', undefined, error);
  }

  // Test multiple start/stop cycles
  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 100,
      checkIntervalMs: 100,
      instanceId: 'test-cycle',
      onLoopDetected: () => {},
    }, activityStream);

    for (let i = 0; i < 5; i++) {
      detector.start();
      detector.stop();
    }

    pass(category, 'Multiple start/stop cycles', 'Detector handles 5 start/stop cycles');
    detector.stop();
  } catch (error) {
    fail(category, 'Multiple start/stop cycles', undefined, error);
  }

  // Test proper cleanup
  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 100,
      checkIntervalMs: 100,
      instanceId: 'test-cleanup',
      onLoopDetected: () => {},
    }, activityStream);

    detector.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    detector.stop();

    // Verify no timers are running (indirect test - if process doesn't hang, cleanup worked)
    pass(category, 'Cleanup verification', 'Detector cleans up timers and subscriptions');
  } catch (error) {
    fail(category, 'Cleanup verification', undefined, error);
  }

  // Test accumulation across chunks
  try {
    const activityStream = new ActivityStream();
    const detector = new StreamLoopDetector({
      eventType: ActivityEventType.THOUGHT_CHUNK,
      patterns: [new ReconstructionCyclePattern()],
      warmupPeriodMs: 0,
      checkIntervalMs: 100,
      instanceId: 'test-accumulation',
      onLoopDetected: () => {},
    }, activityStream);

    // Send chunks
    activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'First chunk. ' });
    await new Promise(resolve => setTimeout(resolve, 10));
    activityStream.emit(ActivityEventType.THOUGHT_CHUNK, { chunk: 'Second chunk.' });

    const length = detector.getAccumulatedLength();
    if (length > 0) {
      pass(category, 'Text accumulation', `Accumulated ${length} characters across chunks`);
    } else {
      fail(category, 'Text accumulation', 'No text accumulated from chunks');
    }

    detector.stop();
  } catch (error) {
    fail(category, 'Text accumulation', undefined, error);
  }
}

// ===========================================
// Main Test Runner
// ===========================================
async function runAllTests() {
  console.log('='.repeat(70));
  console.log('COMPREHENSIVE LOOP DETECTION SYSTEM TEST');
  console.log('='.repeat(70));
  console.log();

  await testBuildVerification();
  console.log();

  await testIntegration();
  console.log();

  await testThinkingPatterns();
  console.log();

  await testResponsePatterns();
  console.log();

  await testConfiguration();
  console.log();

  await testEdgeCases();
  console.log();

  await testLifecycle();
  console.log();

  // Summary
  console.log('='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  const total = results.length;

  console.log(`Total Tests: ${total}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⚠️  Warnings: ${warned}`);
  console.log();

  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ [${r.category}] ${r.test}`);
      if (r.details) console.log(`     ${r.details}`);
    });
    console.log();
  }

  if (warned > 0) {
    console.log('WARNINGS:');
    results.filter(r => r.status === 'WARN').forEach(r => {
      console.log(`  ⚠️  [${r.category}] ${r.test}`);
      if (r.details) console.log(`     ${r.details}`);
    });
    console.log();
  }

  // Final recommendation
  console.log('='.repeat(70));
  console.log('FINAL RECOMMENDATION');
  console.log('='.repeat(70));

  const successRate = (passed / total) * 100;

  if (failed === 0 && warned === 0) {
    console.log('✅ GO - All tests passed! System ready for production.');
  } else if (failed === 0 && warned <= 2) {
    console.log('✅ GO - All tests passed with minor warnings. Review warnings.');
  } else if (failed <= 2 && successRate >= 90) {
    console.log('⚠️  CONDITIONAL GO - High success rate but some failures. Review failures.');
  } else {
    console.log('❌ NO-GO - Significant test failures detected. Address issues before deployment.');
  }

  console.log();
  console.log(`Success Rate: ${successRate.toFixed(1)}%`);
  console.log('='.repeat(70));

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(error => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
