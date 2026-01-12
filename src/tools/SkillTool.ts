/**
 * SkillTool - Load skill instructions into context
 *
 * Allows the LLM to load a skill's detailed instructions when needed.
 * This enables "progressive disclosure" - skill instructions only load when requested.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';

export class SkillTool extends BaseTool {
  readonly name = 'skill';
  readonly displayName = 'Load Skill';
  readonly description =
    'Load detailed instructions for a skill. Use this when you need to follow a specific skill\'s workflow.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly hideOutput = true; // Hide instructions from user, they're for the LLM

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'The name of the skill to load (available skills are shown in the system prompt)',
            },
          },
          required: ['skill_name'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const skillName = args.skill_name as string;

    if (!skillName) {
      return this.formatErrorResponse(
        'skill_name parameter is required',
        'validation_error',
        'Example: skill(skill_name="commit")'
      );
    }

    // Get SkillManager from ServiceRegistry
    const registry = ServiceRegistry.getInstance();
    const skillManager = registry.getSkillManager();

    if (!skillManager) {
      return this.formatErrorResponse(
        'Skill system not available',
        'system_error',
        'The skill system has not been initialized'
      );
    }

    // Load the skill
    const skill = await skillManager.getSkill(skillName);

    if (!skill) {
      // Get available skills to provide helpful suggestion
      const availableSkills = await skillManager.listSkills();
      const skillNames = availableSkills.map(s => s.name);

      return this.formatErrorResponse(
        `Skill "${skillName}" not found`,
        'validation_error',
        skillNames.length > 0
          ? `Available skills: ${skillNames.join(', ')}`
          : 'No skills are currently available'
      );
    }

    // Return skill instructions with metadata
    return this.formatSuccessResponse({
      content: skill.instructions,
      skill_name: skill.name,
      skill_description: skill.description,
      skill_source: skill.source,
      system_reminder: `Skill "${skill.name}" loaded. Follow these instructions carefully for this task.`,
    });
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>, _result?: any): string | null {
    const skillName = args.skill_name as string;
    const description = args.description as string;

    if (!skillName) return null;

    if (description) {
      return `${description} (${skillName})`;
    }
    return skillName;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['skill_name', 'description'];
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const skillName = result.skill_name as string;
    const skillDescription = result.skill_description as string;

    lines.push(`Loaded skill: ${skillName}`);
    if (skillDescription) {
      const desc = skillDescription.length > 60
        ? skillDescription.substring(0, 57) + '...'
        : skillDescription;
      lines.push(desc);
    }

    return lines;
  }
}
