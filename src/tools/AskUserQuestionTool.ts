/**
 * AskUserQuestionTool - Gather user input through structured questions
 *
 * Allows the assistant to pause execution and gather user input through
 * a multi-question interface. Supports two question modes:
 *
 * 1. Choice questions: Users select from predefined options or provide
 *    custom input via an automatic "Other" option
 * 2. Free-form questions: Users type their response directly (no options)
 *
 * Features:
 * - 1-10 questions per invocation
 * - Choice mode: 2-6 predefined options with automatic "Other"
 * - Free-form mode: direct text input (omit options array)
 * - Multi-select mode for non-mutually-exclusive choices
 * - Optional context paragraph for additional explanation
 * - Header/tag for quick visual identification
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, FormSchema, FormField } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS } from '../config/constants.js';

/**
 * Truncate text to a maximum number of words, adding ellipsis if truncated
 */
function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) {
    return text;
  }
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Option for a question
 */
interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Question definition
 */
interface Question {
  question: string;
  header: string;
  options?: QuestionOption[];  // Optional - if omitted, creates free-form text input
  multiSelect?: boolean;       // Only relevant when options provided
  context?: string;            // Optional explanatory paragraph shown before options
}

/**
 * Tool arguments
 */
interface AskUserQuestionArgs {
  questions: Question[];
}

export class AskUserQuestionTool extends BaseTool {
  readonly name = 'ask-user-question';
  readonly displayName = 'Questions';
  readonly description =
    'Ask the user questions. Prefer structured choices (2-5 options, automatic "Other") over free-form. Only omit options for unpredictable answers like names or URLs. 1-10 questions per invocation.';
  readonly requiresConfirmation = false;
  readonly supportsInteractiveForm = true;
  readonly alwaysShowFullOutput = true;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              description: 'Array of 1-10 questions to ask the user',
              items: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'The full question text, should end with "?"',
                  },
                  header: {
                    type: 'string',
                    description: 'Short tag/label for quick identification (max 16 chars). Examples: "Auth method", "Library", "Approach"',
                  },
                  options: {
                    type: 'array',
                    description: '2-6 predefined options (preferred). Do NOT include "Other"—it is added automatically. Omit array only for unpredictable answers.',
                    items: {
                      type: 'object',
                      properties: {
                        label: {
                          type: 'string',
                          description: 'Concise display text (1-5 words)',
                        },
                        description: {
                          type: 'string',
                          description: 'Explanation of implications, trade-offs, or what this option means',
                        },
                      },
                      required: ['label', 'description'],
                    },
                  },
                  multiSelect: {
                    type: 'boolean',
                    description: 'If true, user can select multiple options (checkboxes). If false, single selection (radio buttons). Only relevant when options are provided.',
                  },
                  context: {
                    type: 'string',
                    description: 'Optional explanatory paragraph displayed before the question. Use to provide background or additional context.',
                  },
                },
                required: ['question', 'header'],
              },
            },
          },
          required: ['questions'],
        },
      },
    };
  }

  /**
   * Build form schema from questions
   */
  private buildFormSchema(questions: Question[]): FormSchema {
    const fields: FormField[] = [];

    for (const q of questions) {
      // Add context label field if provided
      if (q.context) {
        fields.push({
          name: `${q.header}_context`,
          type: 'label' as const,
          label: q.header,
          description: q.context,
        });
      }

      // Check if this is a free-form question (no options)
      const isFreeForm = !q.options || q.options.length === 0;

      if (isFreeForm) {
        // Free-form text input
        fields.push({
          name: q.header,
          type: 'string' as const,
          label: q.header,
          description: q.question,
          required: true,
        });
      } else {
        // Build choices from options + automatic "Other"
        const choices = [
          ...q.options!.map((opt, i) => ({
            value: opt.label,
            label: `${i + 1}. ${opt.label}`,
            description: opt.description,
          })),
          {
            value: '__other__',
            label: `${q.options!.length + 1}. Other`,
            description: 'Type a custom response',
          },
        ];

        fields.push({
          name: q.header,
          type: 'choice' as const,
          label: q.header,
          description: q.question,
          required: true,
          choices,
          multiSelect: q.multiSelect,
        });
      }
    }

    return {
      title: questions.length === 1 ? questions[0]!.header : 'Questions',
      description: questions.length === 1 && !questions[0]!.context ? questions[0]!.question : undefined,
      fields,
    };
  }

  protected async executeImpl(args: AskUserQuestionArgs): Promise<ToolResult> {
    this.captureParams(args);

    const { questions } = args;

    // Validate questions
    if (!questions || !Array.isArray(questions)) {
      return this.formatErrorResponse(
        'questions parameter is required and must be an array',
        'validation_error'
      );
    }

    if (questions.length < 1 || questions.length > 10) {
      return this.formatErrorResponse(
        'Must provide 1-10 questions',
        'validation_error'
      );
    }

    // Validate each question
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q) continue;

      if (!q.question || typeof q.question !== 'string') {
        return this.formatErrorResponse(
          `Question ${i + 1}: question text is required`,
          'validation_error'
        );
      }

      if (!q.header || typeof q.header !== 'string') {
        return this.formatErrorResponse(
          `Question ${i + 1}: header is required`,
          'validation_error'
        );
      }

      if (q.header.length > 20) {
        return this.formatErrorResponse(
          `Question ${i + 1}: header must be max 20 characters (got ${q.header.length})`,
          'validation_error'
        );
      }

      // Options are optional - if provided, validate them
      if (q.options !== undefined) {
        if (!Array.isArray(q.options)) {
          return this.formatErrorResponse(
            `Question ${i + 1}: options must be an array`,
            'validation_error'
          );
        }

        if (q.options.length > 0 && (q.options.length < 2 || q.options.length > 6)) {
          return this.formatErrorResponse(
            `Question ${i + 1}: must have 2-6 options (got ${q.options.length})`,
            'validation_error'
          );
        }

        for (let j = 0; j < q.options.length; j++) {
          const opt = q.options[j];
          if (!opt || !opt.label || !opt.description) {
            return this.formatErrorResponse(
              `Question ${i + 1}, Option ${j + 1}: label and description are required`,
              'validation_error'
            );
          }
        }
      }

      // multiSelect is optional, only validate if provided
      if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
        return this.formatErrorResponse(
          `Question ${i + 1}: multiSelect must be a boolean`,
          'validation_error'
        );
      }
    }

    try {
      // Build form schema
      const schema = this.buildFormSchema(questions);

      // Request form from user
      const formData = await this.requestForm(schema);

      // Build response - map header to answer and format output
      const answers: Record<string, string | string[]> = {};
      const formattedLines: string[] = [];

      for (const q of questions) {
        // Form data contains the actual answer - for "Other" selections,
        // the UI stores the typed text directly (not '__other__')
        const answer = formData[q.header];
        answers[q.header] = answer;

        // Format as "Question → Answer" with truncation for display
        const answerStr = Array.isArray(answer) ? answer.join(', ') : answer;
        const truncatedQuestion = truncateWords(q.question, TEXT_LIMITS.QUESTION_ANSWER_MAX_WORDS);
        const truncatedAnswer = truncateWords(answerStr, TEXT_LIMITS.QUESTION_ANSWER_MAX_WORDS);
        formattedLines.push(`${truncatedQuestion} → ${truncatedAnswer}`);
      }

      return this.formatSuccessResponse({
        content: formattedLines.join('\n'),
        answers,
      });
    } catch (error: any) {
      if (error.name === 'FormCancelledError') {
        return this.formatErrorResponse(
          'User cancelled the question dialog',
          'form_cancelled'
        );
      }
      return this.formatErrorResponse(
        `Error asking user: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
