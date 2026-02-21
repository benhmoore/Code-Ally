/**
 * Thoroughness-specific prompt adjustments for agent system prompts
 *
 * Generates concise, level-specific guidelines via templates to avoid
 * duplicating shared instructions across variants. Shared context
 * (READ-ONLY access, write-temp, etc.) belongs in the agent base prompt.
 */

/** Level-specific configuration */
interface ThoroughnessConfig {
  label: string;
  timeLimit: string;
  toolCalls: string;
  delegation: string;
  extras?: string[];
}

const EXPLORE_CONFIGS: Record<string, ThoroughnessConfig> = {
  quick: {
    label: 'QUICK',
    timeLimit: '~1 minute maximum',
    toolCalls: '2-5',
    delegation: 'Only delegate if task clearly splits into 2+ parallel quick searches',
    extras: [
      'Prioritize grep/glob over extensive file reading',
      'Focus on speed over comprehensiveness',
    ],
  },
  medium: {
    label: 'MEDIUM',
    timeLimit: '~3 minutes maximum',
    toolCalls: '3-6 (if not delegating)',
    delegation: 'Strongly consider delegation for multi-area explorations',
    extras: [
      'If exploring 2+ distinct areas, prefer parallel explore() calls',
      'Highlight key files, patterns, and architectural decisions',
    ],
  },
  'very thorough': {
    label: 'VERY THOROUGH',
    timeLimit: '~6 minutes maximum',
    toolCalls: '6-12 (if not delegating)',
    delegation: 'DEFAULT to delegation for complex explorations with multiple components',
    extras: [
      'Use "overview then deep dive" pattern: map the landscape, then delegate details',
      'Cross-reference findings across multiple files',
      'Create separate note files for different aspects',
    ],
  },
  uncapped: {
    label: 'UNCAPPED',
    timeLimit: 'No time limit imposed',
    toolCalls: 'as needed',
    delegation: 'PREFER delegation for any multi-part exploration',
    extras: [
      'Consider "divide and conquer" pattern: split by architectural boundaries',
      'Complex codebase explorations should almost always use delegation strategy',
    ],
  },
};

const PLAN_CONFIGS: Record<string, ThoroughnessConfig> = {
  quick: {
    label: 'QUICK',
    timeLimit: '~1 minute maximum',
    toolCalls: '5-10',
    delegation: 'Use explore() only for complex multi-file analysis',
    extras: ['Focus on speed and efficiency'],
  },
  medium: {
    label: 'MEDIUM',
    timeLimit: '~3 minutes maximum',
    toolCalls: '6-9',
    delegation: 'Use explore() for complex multi-file pattern analysis',
    extras: [
      'Include code examples from codebase when relevant',
      'Focus on artful implementation that fits existing architecture',
    ],
  },
  'very thorough': {
    label: 'VERY THOROUGH',
    timeLimit: '~6 minutes maximum',
    toolCalls: '9-12',
    delegation: 'Use explore() for complex multi-file pattern analysis',
    extras: [
      'Include code examples from codebase when relevant',
      'Ensure plan is complete and comprehensive',
    ],
  },
  uncapped: {
    label: 'UNCAPPED',
    timeLimit: 'No time limit imposed',
    toolCalls: 'as many as needed',
    delegation: 'Use explore() freely for thorough analysis',
    extras: [
      'Include code examples from codebase when relevant',
      'Ensure plan is complete and comprehensive',
    ],
  },
};

function buildGuidelines(config: ThoroughnessConfig, agentType: string): string {
  const lines = [
    `**Thoroughness: ${config.label}**`,
    `- **Time**: ${config.timeLimit}`,
    `- **Tool calls**: Aim for ${config.toolCalls}`,
    `- **Delegation**: ${config.delegation}`,
  ];

  if (agentType === 'plan') {
    lines.push(
      '- Ground recommendations in existing patterns (or modern best practices for new projects)',
      '- Recognize empty projects quickly - don\'t search for patterns that don\'t exist',
    );
  }

  if (config.extras) {
    for (const extra of config.extras) {
      lines.push(`- ${extra}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get thoroughness-specific guidelines for an agent type
 */
export function getThoroughnessGuidelines(agentType: string, thoroughness: string): string | null {
  if (agentType === 'explore') {
    const config = EXPLORE_CONFIGS[thoroughness] ?? EXPLORE_CONFIGS['uncapped']!;
    return buildGuidelines(config!, agentType);
  } else if (agentType === 'plan') {
    const config = PLAN_CONFIGS[thoroughness] ?? PLAN_CONFIGS['uncapped']!;
    return buildGuidelines(config!, agentType);
  }

  return null;
}
