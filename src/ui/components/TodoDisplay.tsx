/**
 * TodoDisplay - Compact real-time todo list display
 *
 * Shows the next-up todo and up to 2 more in a single row below the input prompt.
 * Hidden when no incomplete todos exist.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager, TodoItem } from '../../services/TodoManager.js';

/**
 * TodoDisplay Component
 *
 * Renders a compact single-line display of active todos:
 * - First incomplete todo highlighted as "NEXT"
 * - Up to 2 additional incomplete todos
 * - Nothing rendered if no incomplete todos
 */
export const TodoDisplay: React.FC = () => {
  const [incompleteTodos, setIncompleteTodos] = useState<TodoItem[]>([]);

  // Poll for todo updates
  useEffect(() => {
    const updateTodos = () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (todoManager) {
          const todos = todoManager.getIncompleteTodos();
          setIncompleteTodos(todos);
        }
      } catch (error) {
        // Silently fail - todo display is not critical
        console.error('[TodoDisplay] Error fetching todos:', error);
      }
    };

    // Initial update
    updateTodos();

    // Poll every 500ms for updates
    const interval = setInterval(updateTodos, 500);

    return () => clearInterval(interval);
  }, []);

  // Don't render if no incomplete todos
  if (incompleteTodos.length === 0) {
    return null;
  }

  // Take only the first 3 incomplete todos
  const displayTodos = incompleteTodos.slice(0, 3);

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text dimColor>→ </Text>
      <Text color="yellow" bold>
        NEXT:{' '}
      </Text>
      <Text>{displayTodos[0]?.task || ''}</Text>

      {/* Show additional todos if they exist */}
      {displayTodos.length > 1 && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor>{displayTodos[1]?.task || ''}</Text>
        </>
      )}

      {displayTodos.length > 2 && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor>{displayTodos[2]?.task || ''}</Text>
        </>
      )}

      {/* Show indicator if more todos exist */}
      {incompleteTodos.length > 3 && (
        <Text dimColor> (+{incompleteTodos.length - 3} more)</Text>
      )}
    </Box>
  );
};
