/**
 * Thoroughness-specific prompt adjustments for agent system prompts
 *
 * This module provides functions to generate thoroughness-specific guidelines
 * that can be dynamically applied to agent system prompts. These adjustments
 * modify agent behavior based on the thoroughness level specified.
 *
 * Currently supports the 'explore' agent type. Extensible to other agent types
 * that may require thoroughness-specific behavior in the future.
 *
 * Usage:
 * ```typescript
 * const guidelines = getThoroughnessGuidelines('explore', 'medium');
 * if (guidelines) {
 *   // Append guidelines to base prompt
 * }
 * ```
 */

/**
 * Get thoroughness-specific guidelines for an agent type
 *
 * @param agentType - The type of agent ('explore', 'plan', etc.)
 * @param thoroughness - The thoroughness level: 'quick', 'medium', 'very thorough', 'uncapped'
 * @returns The thoroughness-specific guidelines string, or null if the agent type doesn't support thoroughness adjustments
 *
 * @example
 * ```typescript
 * const guidelines = getThoroughnessGuidelines('explore', 'medium');
 * // Returns medium thoroughness guidelines for explore agent
 *
 * const planGuidelines = getThoroughnessGuidelines('plan', 'medium');
 * // Returns medium thoroughness guidelines for plan agent
 * ```
 */
export function getThoroughnessGuidelines(agentType: string, thoroughness: string): string | null {
  // Supports 'explore' and 'plan' agent types
  // This function is extensible - other agent types can be added here as needed
  if (agentType === 'explore') {
    return getExploreThoroughnessGuidelines(thoroughness);
  } else if (agentType === 'plan') {
    return getPlanThoroughnessGuidelines(thoroughness);
  }

  return null;
}

/**
 * Get thoroughness-specific guidelines for explore agent
 */
function getExploreThoroughnessGuidelines(thoroughness: string): string | null {
  switch (thoroughness) {
    case 'quick':
      return `**Your Current Thoroughness Level: QUICK**

**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~1 minute maximum** - System reminders will notify you of remaining time
- Be efficient and focused (aim for 2-5 tool calls)
- **Delegation strategy**: Only delegate if task clearly splits into 2+ parallel quick searches
- Prioritize grep/glob over extensive file reading
- Use write-temp if you need to track findings across searches
- Provide quick, concise summaries of findings
- Focus on speed over comprehensiveness
- If you can't find something quickly, explain what you searched`;

    case 'medium':
      return `**Your Current Thoroughness Level: MEDIUM**

**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~3 minutes maximum** - System reminders will notify you of remaining time
- **Delegation strategy**: Strongly consider delegation for multi-area explorations (protects context)
- If exploring 2+ distinct areas, prefer parallel explore() calls over sequential direct investigation
- Be thorough but efficient with tool usage (aim for 3-6 tool calls if not delegating)
- Consider using write-temp to organize findings by category as you discover them
- Review your notes before summarizing to ensure comprehensive coverage
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing`;

    case 'very thorough':
      return `**Your Current Thoroughness Level: VERY THOROUGH**

**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~6 minutes maximum** - System reminders will notify you of remaining time
- **Delegation strategy**: DEFAULT to delegation for complex explorations with multiple components
- Break down into logical sub-explorations (e.g., architecture overview, then deep dives per component)
- Use "overview then deep dive" pattern: First map the landscape, then delegate detailed investigations
- Be comprehensive and meticulous (aim for 6-12 tool calls if not delegating)
- Use write-temp extensively to organize findings as you discover them
- Create separate note files for different aspects (architecture.txt, patterns.txt, dependencies.txt)
- Check multiple locations and consider various naming conventions
- Trace dependencies deeply and understand complete call chains
- Read extensively to build complete understanding
- Cross-reference findings across multiple files
- Investigate edge cases and alternative implementations
- Review and synthesize all notes before providing final detailed summary
- Always provide detailed, structured summaries with extensive context
- Document all patterns, architectural decisions, and relationships found`;

    case 'uncapped':
    default:
      return `**Your Current Thoroughness Level: UNCAPPED**

**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **No time limit imposed** - Take the time needed to do a thorough job
- **Delegation strategy**: PREFER delegation for any multi-part exploration (maximize efficiency)
- Complex codebase explorations should almost always use delegation strategy
- Consider "divide and conquer" pattern: Split by architectural boundaries or directories
- Be comprehensive and systematic with tool usage
- Use write-temp to organize extensive findings into separate note files
- Review your accumulated notes before generating final response
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing`;
  }
}

/**
 * Get thoroughness-specific guidelines for plan agent
 */
function getPlanThoroughnessGuidelines(thoroughness: string): string | null {
  switch (thoroughness) {
    case 'quick':
      return `**Your Current Thoroughness Level: QUICK**

**Important Guidelines:**
- **Time limit: ~1 minute maximum** - System reminders will notify you of remaining time
- Be efficient in research (use 5-10 tool calls depending on codebase complexity)
- **For existing codebases**: Ground recommendations in existing patterns, provide file references
- **For empty/new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- Focus on speed and efficiency`;

    case 'medium':
      return `**Your Current Thoroughness Level: MEDIUM**

**Important Guidelines:**
- **Time limit: ~3 minutes maximum** - System reminders will notify you of remaining time
- Be efficient in research (use 6-9 tool calls depending on codebase complexity)
- **For existing codebases**: Ground recommendations in existing patterns, provide file references
- **For empty/new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- Ensure plan is complete but not over-engineered
- Focus on artful implementation that fits the existing architecture (or establishes good architecture)`;

    case 'very thorough':
      return `**Your Current Thoroughness Level: VERY THOROUGH**

**Important Guidelines:**
- **Time limit: ~6 minutes maximum** - System reminders will notify you of remaining time
- Be thorough in research (use 9-12 tool calls for comprehensive analysis)
- **For existing codebases**: Ground recommendations in existing patterns, provide file references
- **For empty/new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- Ensure plan is complete and comprehensive
- Focus on artful implementation that fits the existing architecture (or establishes good architecture)`;

    case 'uncapped':
    default:
      return `**Your Current Thoroughness Level: UNCAPPED**

**Important Guidelines:**
- **No time limit imposed** - Take the time needed to create a comprehensive plan
- Be thorough in research (use as many tool calls as needed for complete analysis)
- **For existing codebases**: Ground recommendations in existing patterns, provide file references
- **For empty/new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- Ensure plan is complete and comprehensive
- Focus on artful implementation that fits the existing architecture (or establishes good architecture)`;
  }
}
