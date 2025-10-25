#!/usr/bin/env node
/**
 * Test script to verify Ollama handles concurrent requests
 *
 * This will make 2 simultaneous requests and measure timing:
 * - If sequential: time ~= 2x single request time
 * - If concurrent: time ~= 1x single request time
 */

async function makeRequest(id, prompt) {
  const startTime = Date.now();
  console.log(`[${id}] Starting request at ${startTime}...`);

  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss:latest',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
          temperature: 0.7,
          num_ctx: 4096,
          num_predict: 50, // Short response for quick test
        }
      })
    });

    const data = await response.json();
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`[${id}] Completed in ${duration}ms`);
    console.log(`[${id}] Response: ${data.message.content.substring(0, 60)}...`);

    return { id, duration, success: true };
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.error(`[${id}] Failed after ${duration}ms:`, error.message);
    return { id, duration, success: false, error: error.message };
  }
}

async function testConcurrency() {
  console.log('=== Testing Ollama Concurrency ===\n');

  // Test 1: Single request baseline
  console.log('Test 1: Single request baseline');
  const baseline = await makeRequest('BASELINE', 'Say "hello" in 5 words or less.');
  console.log(`Baseline: ${baseline.duration}ms\n`);

  // Wait a bit between tests
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test 2: Two concurrent requests
  console.log('Test 2: Two concurrent requests');
  const startConcurrent = Date.now();
  const results = await Promise.all([
    makeRequest('REQ-1', 'Count from 1 to 5 in words.'),
    makeRequest('REQ-2', 'Name 3 colors in words.')
  ]);
  const totalConcurrent = Date.now() - startConcurrent;

  console.log(`\nTotal concurrent time: ${totalConcurrent}ms`);
  console.log(`Individual timings: ${results.map(r => `${r.id}=${r.duration}ms`).join(', ')}`);

  // Analysis
  console.log('\n=== Analysis ===');
  const expectedSequential = baseline.duration * 2;
  const ratio = totalConcurrent / expectedSequential;

  console.log(`Expected if sequential: ~${expectedSequential}ms`);
  console.log(`Actual concurrent time: ${totalConcurrent}ms`);
  console.log(`Ratio: ${(ratio * 100).toFixed(1)}%`);

  if (ratio < 0.6) {
    console.log('\n✅ RESULT: Ollama is processing requests CONCURRENTLY');
    console.log('   Background tasks should NOT block the main agent.');
  } else if (ratio > 0.9) {
    console.log('\n❌ RESULT: Ollama is processing requests SEQUENTIALLY');
    console.log('   Background tasks WILL block the main agent!');
    console.log('   Consider setting OLLAMA_NUM_PARALLEL=4');
  } else {
    console.log('\n⚠️  RESULT: Ollama has PARTIAL concurrency');
    console.log('   Background tasks may cause some delays.');
  }
}

testConcurrency().catch(console.error);
