/**
 * TodoList - Aligned todo list display
 *
 * Renders todos in three fixed columns so rows line up regardless of status:
 *
 *   → ☐ Current task          (in progress: primary color + arrow)
 *     ☐ Upcoming task         (pending: default text)
 *     ☑ Finished task         (completed: green check, dim struck-through text)
 *
 * Long tasks are truncated rather than wrapped so the columns stay intact.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TodoItem } from '@services/TodoManager.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

interface TodoListProps {
  /** Todos to display, in the order they should appear */
  todos: TodoItem[];
}

const getCheckbox = (status: TodoItem['status']): string =>
  status === 'completed' ? UI_SYMBOLS.TODO.CHECKED : UI_SYMBOLS.TODO.UNCHECKED;

export const TodoList: React.FC<TodoListProps> = ({ todos }) => {
  if (todos.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {todos.map((todo, index) => {
        const isInProgress = todo.status === 'in_progress';
        const isCompleted = todo.status === 'completed';

        return (
          <Box key={index}>
            <Text color={UI_COLORS.PRIMARY}>
              {isInProgress ? `${UI_SYMBOLS.NAVIGATION.ARROW_RIGHT} ` : '  '}
            </Text>
            <Text
              color={
                isInProgress
                  ? UI_COLORS.PRIMARY
                  : isCompleted
                    ? UI_COLORS.SUCCESS
                    : UI_COLORS.TEXT_DEFAULT
              }
              dimColor={isCompleted}
            >
              {getCheckbox(todo.status)}
            </Text>
            <Text> </Text>
            <Text
              color={isInProgress ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DEFAULT}
              dimColor={isCompleted}
              strikethrough={isCompleted}
              wrap="truncate-end"
            >
              {todo.task}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};
