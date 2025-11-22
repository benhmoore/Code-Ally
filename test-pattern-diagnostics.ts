/**
 * Pattern Detection Diagnostic Test
 *
 * Deep dive into why some pattern tests are failing
 */

import {
  RepeatedQuestionPattern,
  RepeatedActionPattern,
  PhraseRepetitionPattern,
  SentenceRepetitionPattern,
} from './src/agent/patterns/loopPatterns.js';
import { extractQuestions, extractActions, extractSentences, findSimilarGroups } from './src/agent/patterns/textAnalysis.js';

console.log('='.repeat(70));
console.log('PATTERN DETECTION DIAGNOSTICS');
console.log('='.repeat(70));
console.log();

// Test RepeatedQuestionPattern
console.log('--- RepeatedQuestionPattern Diagnostic ---');
const text1 = "What should I do? What should we do? What should they do?";
console.log('Text:', text1);

const questions = extractQuestions(text1);
console.log('Extracted questions:', questions);
console.log('Question count:', questions.length);

const questionGroups = findSimilarGroups(questions);
console.log('Similar groups:', questionGroups);

const pattern1 = new RepeatedQuestionPattern();
const result1 = pattern1.check(text1);
console.log('Pattern result:', result1);
console.log();

// Test RepeatedActionPattern
console.log('--- RepeatedActionPattern Diagnostic ---');
const text2 = "I will check the file. I'll check the configuration. I should check the settings.";
console.log('Text:', text2);

const actions = extractActions(text2);
console.log('Extracted actions:', actions);
console.log('Action count:', actions.length);

const actionGroups = findSimilarGroups(actions);
console.log('Similar groups:', actionGroups);

const pattern2 = new RepeatedActionPattern();
const result2 = pattern2.check(text2);
console.log('Pattern result:', result2);
console.log();

// Test PhraseRepetitionPattern
console.log('--- PhraseRepetitionPattern Diagnostic ---');
const text3 = "This is a test phrase. This is another test phrase. This is yet another test phrase.";
console.log('Text:', text3);

const pattern3 = new PhraseRepetitionPattern();
const result3 = pattern3.check(text3);
console.log('Pattern result:', result3);
console.log();

// Test SentenceRepetitionPattern
console.log('--- SentenceRepetitionPattern Diagnostic ---');
const text4 = "The quick brown fox jumps. The quick brown dog jumps. The quick brown cat jumps.";
console.log('Text:', text4);

const sentences = extractSentences(text4);
console.log('Extracted sentences:', sentences);
console.log('Sentence count:', sentences.length);

const sentenceGroups = findSimilarGroups(sentences);
console.log('Similar groups:', sentenceGroups);

const pattern4 = new SentenceRepetitionPattern();
const result4 = pattern4.check(text4);
console.log('Pattern result:', result4);
console.log();

// Test with more similar text
console.log('--- Testing with more similar patterns ---');
const text5 = "I will check the code. I will check the code. I will check the code.";
console.log('Text:', text5);

const actions5 = extractActions(text5);
console.log('Extracted actions:', actions5);

const actionGroups5 = findSimilarGroups(actions5);
console.log('Similar groups:', actionGroups5);

const pattern5 = new RepeatedActionPattern();
const result5 = pattern5.check(text5);
console.log('Pattern result:', result5);
console.log();
