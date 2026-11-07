/** Terminal activity domain: agent. */
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useAgentActivity({ actions, modal, lifetime }: ActivitySubscriptionContext) {
  useDomainActivityEvent(
    ActivityEventType.PROJECT_WIZARD_REQUEST,
    () => {
      modal.setProjectWizardOpen(true);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROJECT_WIZARD_COMPLETE,
    () => {
      modal.setProjectWizardOpen(false);
      actions.addMessage({
        role: 'assistant',
        content: '✓ ALLY.md has been created successfully!',
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROJECT_WIZARD_SKIP,
    () => {
      modal.setProjectWizardOpen(false);
      actions.addMessage({
        role: 'assistant',
        content: 'Project configuration skipped. You can run /project init anytime.',
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_WIZARD_REQUEST,
    event => {
      const { initialDescription } = event.data || {};
      modal.setAgentWizardData({ initialDescription });
      modal.setAgentWizardOpen(true);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_WIZARD_COMPLETE,
    async (event, isCurrent) => {
      const { name, description, systemPrompt, tools, model } = event.data || {};
      modal.setAgentWizardOpen(false);

      const serviceRegistry = ServiceRegistry.getInstance();
      const agentManager = serviceRegistry.get('agent_manager');

      if (agentManager && name && description && systemPrompt) {
        try {
          await agentManager.saveAgent({
            name,
            description,
            system_prompt: systemPrompt,
            tools,
            model,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          if (!isCurrent()) return;

          actions.addMessage({
            role: 'assistant',
            content: `✓ Agent '${name}' has been created successfully!\n\nYou can use it with:\n  • agent(task_prompt="...", agent_type="${name}")\n  • /agent use ${name} <task>`,
          });
        } catch (error) {
          if (!isCurrent()) return;
          actions.addMessage({
            role: 'assistant',
            content: `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_WIZARD_SKIP,
    () => {
      modal.setAgentWizardOpen(false);
      actions.addMessage({
        role: 'assistant',
        content: 'Agent creation cancelled. You can run /agent create anytime.',
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_USE_REQUEST,
    async (event, isCurrent) => {
      const { agentName, taskPrompt } = event.data || {};

      if (!agentName || !taskPrompt) {
        actions.addMessage({
          role: 'assistant',
          content: 'Error: Missing agent name or task prompt',
        });
        return;
      }

      const serviceRegistry = ServiceRegistry.getInstance();
      const toolManager = serviceRegistry.get('tool_manager');
      const agentTool = toolManager?.getTool('agent');

      if (!agentTool) {
        actions.addMessage({
          role: 'assistant',
          content: 'Error: Agent tool not available',
        });
        return;
      }

      try {
        const result = await agentTool.execute({
          task_prompt: taskPrompt,
          agent_type: agentName,
        });
        if (!isCurrent()) return;

        if (result.success) {
          const response = typeof result.agent_response === 'string' ? result.agent_response : 'Agent completed task';
          actions.addMessage({
            role: 'assistant',
            content: response,
          });
        } else {
          actions.addMessage({
            role: 'assistant',
            content: `Agent execution failed: ${result.error}`,
          });
        }
      } catch (error) {
        if (!isCurrent()) return;
        actions.addMessage({
          role: 'assistant',
          content: `Error executing agent: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    lifetime
  );
}
