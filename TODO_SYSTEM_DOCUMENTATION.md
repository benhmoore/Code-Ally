# Claude Code Todo System Documentation

## Table of Contents
1. [Feature Overview](#feature-overview)
2. [Requirements Specification](#requirements-specification)

---

# Feature Overview

## What is the Todo System?

The Todo System is a built-in task management feature that helps Claude Code organize, track, and provide visibility into multi-step software engineering tasks during conversations.

## When Todos Are Used

Claude Code **proactively** creates todo lists in these scenarios:

1. **Complex multi-step tasks** - 3+ distinct steps
2. **Non-trivial tasks** - Requires careful planning or multiple operations
3. **User explicitly requests it** - You ask for a todo list
4. **Multiple tasks provided** - You give a numbered/comma-separated list
5. **After receiving new instructions** - To capture requirements immediately

Todos are **skipped** for:
- Single, straightforward tasks
- Trivial operations (< 3 simple steps)
- Purely conversational/informational questions

## Task States

Each todo has three states:
- **pending**: Not started yet
- **in_progress**: Currently working on (exactly ONE at a time)
- **completed**: Fully finished

## Typical Conversation Flow

```
User: "Add dark mode toggle, run tests, and fix any failures"

Claude: Creates todo list:
    1. [pending] Create dark mode toggle component
    2. [pending] Add dark mode state management
    3. [pending] Implement theme styles
    4. [pending] Run tests and fix failures

Claude: Marks #1 as in_progress → implements it → marks #1 completed
Claude: Marks #2 as in_progress → implements it → marks #2 completed
... and so on
```

## Key Principles

- **Immediate completion**: Tasks are marked done right after finishing (no batching)
- **One active task**: Exactly one task `in_progress` at any time
- **Only mark completed when FULLY done**: If tests fail or there are errors, it stays `in_progress`
- **Real-time updates**: Status updates happen as work progresses to give you visibility

## Benefits

The system helps Claude Code:
- Stay organized during complex operations
- Ensure no requirements are forgotten
- Provide clear visibility into progress
- Break down large tasks into manageable steps
- Track blockers and follow-up work

---

# Requirements Specification

## 1. Overview

The Todo System is a task management mechanism that tracks, organizes, and provides visibility into multi-step software engineering tasks during Claude Code sessions.

## 2. Functional Requirements

### 2.1 Task Creation (FR-1)

**FR-1.1** The system SHALL create a todo list when any of the following conditions are met:
- The task requires 3 or more distinct steps
- The task is non-trivial and requires careful planning or multiple operations
- The user explicitly requests a todo list
- The user provides multiple tasks in a numbered or comma-separated format
- New instructions are received that require tracking

**FR-1.2** The system SHALL NOT create a todo list when:
- Only a single, straightforward task exists
- The task is trivial and tracking provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

**FR-1.3** Each task SHALL contain two required text fields:
- `content`: Imperative form describing what needs to be done (e.g., "Run tests")
- `activeForm`: Present continuous form shown during execution (e.g., "Running tests")

**FR-1.4** Each task SHALL contain exactly one status field with allowed values: `pending`, `in_progress`, or `completed`

### 2.2 Task State Management (FR-2)

**FR-2.1** The system SHALL maintain exactly ONE task in `in_progress` state at any given time

**FR-2.2** The system SHALL mark a task as `in_progress` BEFORE beginning work on it

**FR-2.3** The system SHALL mark a task as `completed` IMMEDIATELY after finishing it (no batching allowed)

**FR-2.4** The system SHALL mark a task as `completed` ONLY when the task is FULLY accomplished

**FR-2.5** The system SHALL NOT mark a task as `completed` if any of the following conditions exist:
- Tests are failing
- Implementation is partial
- Unresolved errors were encountered
- Necessary files or dependencies could not be found

**FR-2.6** The system SHALL keep tasks in `in_progress` state when blocked or incomplete

**FR-2.7** The system SHALL create new tasks describing blockers when blocked on existing tasks

**FR-2.8** The system SHALL remove tasks from the list entirely when they are no longer relevant

**FR-2.9** The system SHALL update task status in real-time as work progresses

### 2.3 Task Breakdown (FR-3)

**FR-3.1** The system SHALL create specific, actionable task items

**FR-3.2** The system SHALL break complex tasks into smaller, manageable steps

**FR-3.3** The system SHALL use clear, descriptive task names

**FR-3.4** The system SHALL add newly discovered follow-up tasks after completing a task

### 2.4 Task Completion Flow (FR-4)

**FR-4.1** The system SHALL follow this sequence for each task:
1. Mark task as `in_progress`
2. Perform the work
3. Verify completion
4. Mark task as `completed`
5. Move to next task

**FR-4.2** The system SHALL complete current tasks before starting new ones

## 3. Non-Functional Requirements

### 3.1 Visibility (NFR-1)

**NFR-1.1** The system SHALL provide real-time visibility into task progress for the user

**NFR-1.2** The system SHALL demonstrate thoroughness and attentiveness through proactive task management

### 3.2 Reliability (NFR-2)

**NFR-2.1** The system SHALL ensure no tasks are forgotten during complex operations

**NFR-2.2** The system SHALL maintain accurate task state at all times

### 3.3 Frequency (NFR-3)

**NFR-3.1** The system SHALL use the TodoWrite tool VERY frequently

**NFR-3.2** The system SHALL prefer creating a todo list when uncertain ("When in doubt, use this tool")

## 4. System Constraints

### 4.1 State Constraints (C-1)

**C-1.1** EXACTLY ONE task must be in `in_progress` state (not zero, not more than one)

**C-1.2** Task status must be one of three enumerated values: `pending`, `in_progress`, `completed`

**C-1.3** Both `content` and `activeForm` fields must have minimum length of 1 character

### 4.2 Timing Constraints (C-2)

**C-2.1** Task completion marking must occur immediately after task completion (no batching delays)

**C-2.2** Task status updates must occur in real-time

### 4.3 Critical Constraint (C-3)

**C-3.1** Failure to use the todo system for planning is UNACCEPTABLE and may result in forgotten tasks

## 5. System Behavior

### 5.1 Initialization

**SB-1.1** When the todo list is empty and a multi-step task begins, the system receives a reminder to create a todo list

**SB-1.2** The reminder is automatic and transparent to the user

### 5.2 Operational Behavior

**SB-2.1** The system proactively manages todos without requiring explicit user commands

**SB-2.2** The system uses TodoWrite tool to persist all todo state changes

### 5.3 Edge Cases

**SB-3.1** When multiple complex features are requested, the system SHALL break down each feature into specific tasks

**SB-3.2** When performance issues are requested to be fixed, the system SHALL first analyze the codebase, then create specific optimization tasks

**SB-3.3** When encountering pre-commit hook failures or build errors, the system SHALL NOT mark related tasks as completed until resolved

## 6. Interface Requirements

### 6.1 Tool Interface (IF-1)

**IF-1.1** The system SHALL use the TodoWrite tool with the following schema:
```json
{
  "todos": [
    {
      "content": "string (required, min length 1)",
      "activeForm": "string (required, min length 1)",
      "status": "enum (required: pending|in_progress|completed)"
    }
  ]
}
```

## 7. Examples of Compliant Behavior

### 7.1 Multi-Step Task Example
```
User Request: "Run the build and fix any type errors"
System Response:
1. Create todos: ["Run the build", "Fix any type errors"]
2. Mark "Run the build" as in_progress
3. Execute build
4. Discover 10 type errors
5. Add 10 specific error-fix todos
6. Mark "Run the build" as completed
7. Mark first error fix as in_progress
8. Fix first error
9. Mark first error as completed
10. Repeat for all errors
```

### 7.2 Feature Implementation Example
```
User Request: "Add dark mode toggle, run tests"
System Response:
1. Create todos with breakdown:
   - Create dark mode toggle component
   - Add dark mode state management
   - Implement theme styles
   - Run tests
2. Execute each sequentially with proper state transitions
```

## 8. Success Criteria

**SC-1** No tasks are forgotten or skipped during complex operations

**SC-2** User has clear visibility into current progress at all times

**SC-3** Task completion state accurately reflects actual implementation status

**SC-4** System maintains exactly one active task throughout execution

**SC-5** All multi-step tasks are properly tracked from inception to completion

---

**Document Version:** 1.0
**Last Updated:** 2025-10-23
