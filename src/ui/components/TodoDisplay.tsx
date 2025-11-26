/**
 * TodoDisplay - Compact real-time todo list display
 *
 * Shows the next-up todo and up to 2 more in a single row below the input prompt.
 * Hidden when no incomplete todos exist.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { TodoManager, TodoItem } from '@services/TodoManager.js';
import { POLLING_INTERVALS, BUFFER_SIZES } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';

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

    // Poll for updates
    const interval = setInterval(updateTodos, POLLING_INTERVALS.TODO_DISPLAY);

    return () => clearInterval(interval);
  }, []);

  // Don't render if no incomplete todos
  if (incompleteTodos.length === 0) {
    return null;
  }

  // Helper to get display text for a todo (includes active subtask if present)
  const getTodoDisplayText = (todo: TodoItem | undefined): string => {
    if (!todo) return '';

    // Subtasks removed in simplified todo system
    return todo.task;
  };

  // Take only the first N incomplete todos
  const displayTodos = incompleteTodos.slice(0, BUFFER_SIZES.MAX_TODO_DISPLAY_ITEMS);

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text dimColor>→ </Text>
      <Text color={UI_COLORS.PRIMARY} bold>
        NEXT:{' '}
      </Text>
      <Text>{getTodoDisplayText(displayTodos[0])}</Text>

      {/* Show additional todos if they exist */}
      {displayTodos.length > 1 && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor>{getTodoDisplayText(displayTodos[1])}</Text>
        </>
      )}

      {displayTodos.length > 2 && (
        <>
          <Text dimColor> | </Text>
          <Text dimColor>{getTodoDisplayText(displayTodos[2])}</Text>
        </>
      )}

      {/* Show indicator if more todos exist */}
      {incompleteTodos.length > BUFFER_SIZES.MAX_TODO_DISPLAY_ITEMS && (
        <Text dimColor> (+{incompleteTodos.length - BUFFER_SIZES.MAX_TODO_DISPLAY_ITEMS} more)</Text>
      )}
    </Box>
  );
};
