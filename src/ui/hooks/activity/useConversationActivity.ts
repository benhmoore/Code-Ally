/** Terminal activity domain: conversation. */
import { useEffect, useState } from 'react';
import { useConversationSelector, selectThinking } from '../useConversationSelector.js';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { resolveDisplayContent } from '../../../utils/toolResultContent.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useConversationActivity({ state, actions, modal, agent, lifetime }: ActivitySubscriptionContext) {
  const isThinking = useConversationSelector(agent.getSession(), selectThinking);
  const [isCancelling, setIsCancelling] = useState(false);
  useEffect(() => {
    if (!isThinking && isCancelling) setIsCancelling(false);
  }, [isThinking, isCancelling]);
  useDomainActivityEvent(
    ActivityEventType.TOOL_CALL_END,
    event => {
      if (event.data?.groupExecution) return;
      const call = agent
        .getConversationView()
        .getSnapshot()
        .activeToolCalls.find(item => item.id === event.id);
      if (call)
        ServiceRegistry.getInstance()
          .getToolCallHistory()
          ?.addCall({
            ...call,
            status: event.data.success ? 'success' : 'error',
            endTime: event.timestamp,
            output: resolveDisplayContent(event.data.result) || event.data.output || call.output,
            error: event.data.error,
            result: event.data.result,
          });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SYSTEM_PROMPT_DISPLAY,
    event => {
      const agentType = event.data?.agentType || 'Agent';
      const systemPrompt = event.data?.systemPrompt || '';

      if (state.config?.show_system_prompt_in_chat && systemPrompt) {
        actions.addMessage({
          role: 'assistant',
          content: `**System Prompt for ${agentType}:**\n\n\`\`\`\n${systemPrompt}\n\`\`\``,
          timestamp: Date.now(),
        });
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_START,
    event => {
      if (event.data?.isSpecializedAgent && event.data.agentName) actions.addSubAgent(event.data.agentName);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_END,
    event => {
      if (event.data?.isSpecializedAgent && event.data.agentName) actions.removeSubAgent(event.data.agentName);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.USER_INTERRUPT_INITIATED,
    () => {
      setIsCancelling(true);
      state.activeSubAgents.forEach(agentName => actions.removeSubAgent(agentName));
      modal.clearTransientModals();
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.AGENT_SWITCHED,
    event => {
      const { agentName, agentModel } = event.data || {};
      if (agentName) {
        actions.setCurrentAgent(agentName, agentModel);
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.CONVERSATION_CLEAR,
    () => {
      const serviceRegistry = ServiceRegistry.getInstance();

      // Clear all UI state
      actions.clearRewindNotices();

      // Clear todos
      const todoManager = serviceRegistry.get('todo_manager');
      todoManager?.setTodos([]);

      // Reset conversation view to empty (like initial app load)
      actions.repaintConversationSurface();

      // Reset context usage
      actions.setContextUsage(0);
    },
    lifetime
  );
  return { isCancelling };
}
