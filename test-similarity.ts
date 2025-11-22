/**
 * Similarity calculation diagnostic
 */

import { areTextsSimilar } from './src/agent/patterns/textAnalysis.js';

console.log('='.repeat(70));
console.log('SIMILARITY CALCULATION DIAGNOSTICS');
console.log('='.repeat(70));
console.log();

// Test cases from failed tests
const pairs = [
  ['What should I do', 'What should we do'],
  ['What should I do', 'What should they do'],
  ['What should we do', 'What should they do'],
  ['I will check the file.', "I'll check the configuration."],
  ['I will check the file.', 'I should check the settings.'],
  ['The quick brown fox jumps', 'The quick brown dog jumps'],
  ['The quick brown fox jumps', 'The quick brown cat jumps'],
];

pairs.forEach(([text1, text2]) => {
  const similar = areTextsSimilar(text1, text2, 0.7);
  console.log(`Text 1: "${text1}"`);
  console.log(`Text 2: "${text2}"`);
  console.log(`Similar (70%): ${similar}`);

  // Calculate actual similarity
  const words1 = new Set(
    text1
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  const words2 = new Set(
    text2
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  const intersection = new Set(Array.from(words1).filter(w => words2.has(w)));
  const union = new Set(Array.from(words1).concat(Array.from(words2)));
  const similarity = union.size > 0 ? intersection.size / union.size : 0;

  console.log(`Words1 (>2 chars): ${Array.from(words1).join(', ')}`);
  console.log(`Words2 (>2 chars): ${Array.from(words2).join(', ')}`);
  console.log(`Intersection: ${Array.from(intersection).join(', ')}`);
  console.log(`Jaccard similarity: ${(similarity * 100).toFixed(1)}%`);
  console.log();
});
