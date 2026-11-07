/** Terminal activity domain: library. */
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { logger } from '@services/Logger.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useLibraryActivity({ actions, modal, lifetime }: ActivitySubscriptionContext) {
  useDomainActivityEvent(
    ActivityEventType.LIBRARY_SELECT_REQUEST,
    async (_event, isCurrent) => {
      const serviceRegistry = ServiceRegistry.getInstance();
      const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

      if (!promptLibraryManager) return;

      try {
        const prompts = await promptLibraryManager.getPrompts();
        if (!isCurrent()) return;

        modal.setLibrarySelectRequest({
          requestId: `library_select_${Date.now()}`,
          prompts,
          selectedIndex: 0,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error('Failed to fetch prompts:', error);
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.LIBRARY_SELECT_RESPONSE,
    async (event, isCurrent) => {
      const { promptId, cancelled } = event.data;

      modal.setLibrarySelectRequest(undefined);

      if (!cancelled && promptId) {
        const serviceRegistry = ServiceRegistry.getInstance();
        const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

        if (!promptLibraryManager) return;

        try {
          const prompt = await promptLibraryManager.getPrompt(promptId);
          if (!isCurrent()) return;

          if (prompt) {
            // Insert prompt content into input field and mark as prefilled
            modal.setInputPrefillText(prompt.content);
            modal.setPromptPrefilled(true);
          } else {
            // Log error but don't add to chat
            logger.error(`Prompt '${promptId}' not found`);
          }
        } catch (error) {
          if (!isCurrent()) return;
          // Log error but don't add to chat
          logger.error('Failed to load prompt:', error);
        }
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROMPT_MESSAGE_SELECT_REQUEST,
    event => {
      const { requestId, messages, selectedIndex } = event.data;

      modal.setMessageSelectRequest({
        requestId,
        messages,
        selectedIndex,
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
    event => {
      const { selectedMessage, cancelled } = event.data;

      // Close message selector
      modal.setMessageSelectRequest(undefined);

      if (cancelled) {
        // User pressed Escape - cancel entire flow
        return;
      }

      // Show prompt add wizard with optional pre-filled content
      modal.setPromptAddRequest({
        requestId: `prompt_add_${Date.now()}`,
        title: '',
        content: selectedMessage?.content || '', // Pre-filled or empty
        tags: '',
        focusedField: 'title', // Start on title field
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROMPT_ADD_REQUEST,
    event => {
      const { requestId, promptId, title, content, tags, focusedField } = event.data;

      modal.setPromptAddRequest({
        requestId,
        promptId, // Optional: present when editing
        title: title || '',
        content: content || '',
        tags: tags || '',
        focusedField: focusedField || 'title',
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.LIBRARY_CLEAR_CONFIRM_REQUEST,
    event => {
      const { requestId, promptCount, selectedIndex } = event.data;

      modal.setLibraryClearConfirmRequest({
        requestId,
        promptCount,
        selectedIndex: selectedIndex ?? 1, // Default to "Cancel" option (safer)
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
    async (event, isCurrent) => {
      const { confirmed, cancelled } = event.data;

      modal.setLibraryClearConfirmRequest(undefined);

      if (cancelled || !confirmed) {
        // User cancelled - do nothing
        return;
      }

      // User confirmed - clear all prompts
      const serviceRegistry = ServiceRegistry.getInstance();
      const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

      if (!promptLibraryManager) return;

      try {
        const count = await promptLibraryManager.clearAllPrompts();
        if (!isCurrent()) return;

        actions.addMessage({
          role: 'assistant',
          content: `Cleared ${count} saved prompt(s).`,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error('Failed to clear prompts:', error);
        actions.addMessage({
          role: 'assistant',
          content: `Error clearing prompts: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PROMPT_ADD_RESPONSE,
    async (event, isCurrent) => {
      const { promptId, title, content, tags, cancelled } = event.data;

      modal.setPromptAddRequest(undefined);

      if (!cancelled && title && content) {
        const serviceRegistry = ServiceRegistry.getInstance();
        const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

        if (!promptLibraryManager) return;

        try {
          // Parse tags from comma-separated string
          const tagArray = tags
            ? tags
                .split(',')
                .map((t: string) => t.trim())
                .filter((t: string) => t.length > 0)
            : undefined;

          if (promptId) {
            // Edit existing prompt
            await promptLibraryManager.updatePrompt(promptId, {
              title,
              content,
              tags: tagArray,
            });
            if (!isCurrent()) return;

            actions.addMessage({
              role: 'assistant',
              content: `Prompt updated: ${title}`,
            });
          } else {
            // Create new prompt
            const newPrompt = await promptLibraryManager.addPrompt(title, content, tagArray);
            if (!isCurrent()) return;

            actions.addMessage({
              role: 'assistant',
              content: `Prompt saved: ${newPrompt.title} (ID: ${newPrompt.id})`,
            });
          }
        } catch (error) {
          if (!isCurrent()) return;
          logger.error('Failed to save prompt:', error);
          actions.addMessage({
            role: 'assistant',
            content: `Error saving prompt: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    },
    lifetime
  );
}
