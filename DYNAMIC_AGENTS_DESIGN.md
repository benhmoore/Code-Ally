# Dynamic Agent Creation - Design Proposal

## Overview
Enable Ally to create custom specialized agents per profile that persist across conversations.

**Key Insight**: This is MUCH simpler than dynamic tools because:
- ✅ No code generation - just configuration
- ✅ No security concerns - agents don't execute code
- ✅ Infrastructure exists - `AgentManager.saveAgent()` already works
- ✅ Format is simple - markdown with YAML frontmatter
- ✅ Profile-scoped by default

## Current Architecture (Already Built!)

### Agent Storage
```
~/.ally/profiles/{profile}/agents/{agent-name}.md
```

### Agent Format
```markdown
---
name: "agent-name"
description: "One-line description"
model: "sonnet"                              # Optional: haiku|sonnet|opus
temperature: 0.7                             # Optional
reasoning_effort: "medium"                   # Optional: low|medium|high|inherit
tools: ["Read", "Write", "Bash"]             # Optional: restrict tool access (empty = all tools)
usage_guidelines: |                          # Optional: when to use this agent
  **When to use:** Specific use cases
  **When NOT to use:** Cases to avoid
visible_from_agents: ["explore", "plan"]     # Optional: which agents can call this
can_delegate_to_agents: true                 # Optional: can spawn sub-agents
can_see_agents: true                         # Optional: can see agent/explore/plan tools
created_at: "2025-11-23T10:30:00Z"
updated_at: "2025-11-23T10:30:00Z"
---

System prompt content here.

This defines the agent's behavior, expertise, and instructions.
Can be multiple paragraphs with specific guidance.
```

### Existing API
**AgentManager** (`src/services/AgentManager.ts`) provides:
- `saveAgent(agent: AgentData): Promise<boolean>` - Save agent to profile
- `loadAgent(agentName: string): Promise<AgentData | null>` - Load agent
- `deleteAgent(agentName: string): Promise<boolean>` - Remove agent
- `listAgents(): Promise<AgentInfo[]>` - List all agents
- `agentExists(agentName: string): Promise<boolean>` - Check if exists

**Already supports**:
- Profile isolation (automatic via `getAgentsDir()`)
- Priority resolution (user > plugin > built-in)
- Agent visibility controls
- Tool restrictions per agent
- Delegation controls

## What's Missing?

### 1. Agent Creation Tool (New)
**Location**: `src/tools/CreateAgentTool.ts`

```typescript
class CreateAgentTool extends BaseTool {
  name = 'create-agent';
  description = 'Create a custom specialized agent for the current profile';
  requiresConfirmation = true; // Show preview before creating

  schema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Agent name (kebab-case)',
        pattern: '^[a-z][a-z0-9-]*$'
      },
      description: {
        type: 'string',
        description: 'One-line description of the agent'
      },
      systemPrompt: {
        type: 'string',
        description: 'Detailed system prompt defining agent behavior'
      },
      model: {
        type: 'string',
        enum: ['haiku', 'sonnet', 'opus'],
        description: 'Optional: Model to use (defaults to profile config)'
      },
      temperature: {
        type: 'number',
        description: 'Optional: Temperature 0-1'
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: Tool restrictions (empty = all tools)'
      },
      usageGuidelines: {
        type: 'string',
        description: 'Optional: When to use this agent'
      },
      visibleFromAgents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: Which agents can call this agent'
      },
      canDelegateToAgents: {
        type: 'boolean',
        description: 'Optional: Can spawn sub-agents (default true)'
      }
    },
    required: ['name', 'description', 'systemPrompt']
  };

  async executeImpl(params: CreateAgentParams): Promise<ToolResponse> {
    // 1. Validate agent name (kebab-case, no conflicts)
    // 2. Create AgentData object
    // 3. Use AgentManager.saveAgent()
    // 4. Return success with agent path
  }
}
```

### 2. Agent Management Commands (Optional)

**Slash Commands**:
- `/agents list` - List all custom agents in profile
- `/agents show {name}` - Show agent definition
- `/agents delete {name}` - Remove custom agent
- `/agents edit {name}` - Modify existing agent
- `/agents export {name}` - Export agent for sharing
- `/agents import {file}` - Import agent definition

### 3. Template System (Optional but Recommended)

**Location**: `src/templates/agent-templates/`

Common agent patterns to accelerate creation:

#### Code Review Agent
```markdown
---
name: "code-reviewer"
description: "Reviews code for quality, security, and best practices"
tools: ["Read", "Grep", "Glob"]
temperature: 0.3
usage_guidelines: |
  **When to use:** After completing significant code changes
  **Focus:** Code quality, security vulnerabilities, performance issues
---

You are a code review specialist. Review code for:
1. Security vulnerabilities (OWASP Top 10)
2. Code quality and maintainability
3. Performance issues
4. Best practices violations
5. Documentation completeness

Provide specific, actionable feedback with file:line references.
```

#### Documentation Agent
```markdown
---
name: "doc-writer"
description: "Generates comprehensive documentation from code"
tools: ["Read", "Write", "Grep", "Glob"]
model: "sonnet"
usage_guidelines: |
  **When to use:** Need to document code, APIs, or architecture
  **Output:** Markdown documentation with examples
---

You are a technical documentation specialist. Create clear, comprehensive documentation that includes:
- Purpose and overview
- API reference with examples
- Architecture diagrams (mermaid)
- Usage examples
- Common pitfalls

Write for developers who are new to the codebase.
```

#### Testing Agent
```markdown
---
name: "test-writer"
description: "Generates comprehensive test suites"
tools: ["Read", "Write", "Bash"]
temperature: 0.4
usage_guidelines: |
  **When to use:** Need to write tests for new or existing code
  **Focus:** Edge cases, error handling, integration tests
---

You are a test automation specialist. Generate thorough test suites with:
- Unit tests for all public functions
- Edge case coverage
- Error handling tests
- Integration tests where applicable
- Clear test descriptions

Follow the testing conventions used in the project.
```

#### Refactoring Agent
```markdown
---
name: "refactorer"
description: "Refactors code for better structure and maintainability"
tools: ["Read", "Edit", "Grep", "Glob"]
visible_from_agents: [] # Only main assistant can use
can_delegate_to_agents: false
usage_guidelines: |
  **When to use:** Code needs restructuring without changing behavior
  **Focus:** DRY, SOLID principles, clean architecture
---

You are a refactoring specialist. Improve code structure while preserving behavior:
- Extract duplicated code into reusable functions
- Apply SOLID principles
- Improve naming for clarity
- Reduce complexity
- Maintain backward compatibility

ALWAYS run tests after refactoring to ensure no behavior changes.
```

#### Debugging Agent
```markdown
---
name: "debugger"
description: "Diagnoses and fixes bugs systematically"
tools: ["Read", "Grep", "Bash", "Edit"]
reasoning_effort: "high"
usage_guidelines: |
  **When to use:** Investigating bugs or unexpected behavior
  **Approach:** Systematic hypothesis testing
---

You are a debugging specialist. Approach bugs systematically:

1. **Reproduce** - Understand the bug and how to trigger it
2. **Isolate** - Narrow down the root cause
3. **Hypothesize** - Form theories about what's wrong
4. **Test** - Validate hypotheses with evidence
5. **Fix** - Implement minimal, targeted fix
6. **Verify** - Confirm the bug is resolved

Use logging, tests, and careful code analysis. Explain your reasoning.
```

#### API Design Agent
```markdown
---
name: "api-designer"
description: "Designs clean, RESTful APIs following best practices"
tools: ["Read", "Write"]
model: "sonnet"
temperature: 0.5
usage_guidelines: |
  **When to use:** Designing new APIs or endpoints
  **Focus:** REST principles, consistency, documentation
---

You are an API design specialist. Design APIs that are:
- RESTful and follow HTTP conventions
- Consistent across the codebase
- Well-documented with OpenAPI/Swagger
- Versioned appropriately
- Secure by default (auth, rate limiting, validation)

Provide API specifications before implementation.
```

## Implementation Plan

### Phase 1: Core Tool (1-2 hours)
- [x] AgentManager already exists with all needed methods
- [ ] Create `CreateAgentTool` class
- [ ] Add validation (kebab-case, no conflicts)
- [ ] Implement preview functionality
- [ ] Add to ToolManager registration

### Phase 2: Templates (2-3 hours)
- [ ] Create template directory structure
- [ ] Add 5-10 common agent templates
- [ ] Build template selection UI
- [ ] Add template customization prompts

### Phase 3: Management UI (2-4 hours)
- [ ] Implement slash commands for agent management
- [ ] Add agent inspection/editing
- [ ] Create import/export functionality
- [ ] Add usage analytics (track agent invocations)

### Phase 4: Smart Creation (4-6 hours)
- [ ] Build natural language → agent spec converter
- [ ] Add interactive refinement (ask clarifying questions)
- [ ] Implement agent testing (validate tools work)
- [ ] Add suggested improvements based on usage

## User Experience Flow

### Simple Creation
```
User: "Create an agent that reviews Python code for PEP8 compliance"

Ally: I'll create a specialized Python code review agent.

**Agent Specification:**
- Name: python-pep8-reviewer
- Description: Reviews Python code for PEP8 style compliance
- Tools: Read, Grep, Bash (for running pylint/flake8)
- Model: haiku (fast for style checks)

**System Prompt:**
You are a Python code style specialist. Review code for PEP8 compliance:
- Line length (79 chars)
- Naming conventions
- Import organization
- Whitespace usage
- Docstring format

Use pylint and flake8 to identify issues and provide specific fixes.

Create this agent? [Yes/No]

User: Yes

Ally: ✓ Created agent 'python-pep8-reviewer' in profile 'default'
     You can now use it: /agent python-pep8-reviewer
```

### Template-Based Creation
```
User: "Create a testing agent"

Ally: I have a testing agent template. Would you like to customize it?

**Template: test-writer**
- Generates comprehensive test suites
- Focuses on edge cases and error handling
- Uses Read, Write, Bash tools

Customizations:
1. Keep as-is
2. Customize for specific framework (Jest, Pytest, etc.)
3. Add integration test focus

User: 2 - Pytest

Ally: **Customized for Pytest:**
- Added pytest-specific fixtures
- Included parametrize decorators
- Added conftest.py awareness

Create 'pytest-test-writer' agent? [Yes/No]
```

### Advanced Creation with Iteration
```
User: "I need an agent that helps with database migrations"

Ally: I'll create a database migration agent. Let me ask a few questions:

1. Which database? (PostgreSQL, MySQL, MongoDB, etc.)
2. Migration tool? (Alembic, Flyway, Liquibase, custom)
3. Should it auto-generate migrations or just review them?
4. Need rollback support?

User: 1. PostgreSQL, 2. Alembic, 3. Both, 4. Yes

Ally: **Agent Specification:**
- Name: postgres-alembic-migrator
- Tools: Read, Write, Bash, Grep
- Expertise: PostgreSQL + Alembic migrations
- Capabilities:
  * Auto-generate migrations from model changes
  * Review migrations for safety (no data loss)
  * Generate rollback scripts
  * Check for common issues (missing indexes, N+1 queries)

**System Prompt:** [shows detailed prompt]

Create this agent? [Yes/No/Edit]
```

## Agent Discovery & Usage

### Automatic Context Awareness
When user asks: "Review my code"

Ally checks profile for relevant agents:
- Found: `code-reviewer` agent
- Found: `python-pep8-reviewer` agent

Suggests: "I can use your custom code-reviewer agent. Use it? [Yes/No]"

### Agent Visibility in `/help`
```
Custom Agents (profile: default):
- code-reviewer: Reviews code for quality, security, and best practices
- python-pep8-reviewer: Reviews Python code for PEP8 style compliance
- postgres-alembic-migrator: Manages PostgreSQL Alembic migrations

Use: /agent <name> <task>
Manage: /agents list | show | delete | edit
```

## Advanced Features

### Agent Composition
Create meta-agents that orchestrate multiple specialized agents:

```markdown
---
name: "full-stack-reviewer"
description: "Comprehensive review using multiple specialized agents"
can_delegate_to_agents: true
tools: []  # No direct tools, only delegates
---

You coordinate code review by delegating to specialized agents:

1. Use 'code-reviewer' for general quality review
2. Use 'python-pep8-reviewer' for Python style
3. Use 'test-writer' to suggest missing tests
4. Use 'debugger' if issues are found

Synthesize their feedback into a comprehensive review.
```

### Learning from Usage
Track agent performance:
- Success rate (tasks completed vs failed)
- Average execution time
- User satisfaction (explicit feedback)
- Common failure patterns

Suggest improvements:
"Your 'python-pep8-reviewer' agent has failed 3 times due to missing flake8.
 Would you like me to update it to check for flake8 installation first?"

### Agent Marketplace (Future)
- Export agents as shareable files
- Import community agents
- Version control for agent evolution
- Fork and customize popular agents

## Security & Validation

### Agent Creation Validation
1. **Name validation** - kebab-case, no conflicts
2. **Tool existence** - validate all specified tools exist
3. **Agent references** - validate visible_from_agents references real agents
4. **Schema compliance** - valid YAML frontmatter

### Runtime Protection
- Agents inherit profile permissions (no elevation)
- Tool restrictions enforced by ToolManager
- Delegation limits prevent infinite recursion
- Same security model as built-in agents

## Success Metrics

- Agent creation time < 60 seconds (including iteration)
- 90%+ of created agents used in 3+ conversations
- User satisfaction with agent behavior
- Reduction in repetitive task time (before/after agents)

## Open Questions

1. Should agents be exportable to other profiles?
2. How to handle agent versioning (update vs create new)?
3. Should there be a "test" mode for agents before saving?
4. Community sharing mechanism?
5. Agent analytics dashboard?

## Why This Is Better Than Dynamic Tools

| Aspect | Dynamic Tools | Dynamic Agents |
|--------|---------------|----------------|
| Complexity | High (code generation) | Low (configuration) |
| Security Risk | High (arbitrary code) | None (no code execution) |
| Implementation Time | 2-4 weeks | 1 week |
| User Barrier | Technical | Conversational |
| Iteration Speed | Slow (test/debug code) | Fast (edit prompt) |
| Failure Mode | Silent bugs | Clear prompt issues |
| Maintenance | Requires updates | Self-documenting |
| Composability | Limited | High (agent chains) |

**Recommendation: Start with Dynamic Agents**
- Faster to implement
- Safer to use
- More user-friendly
- Better composability
- Can always add dynamic tools later

The agent approach is fundamentally more aligned with Ally's conversational nature. Users can create specialized "versions of Ally" for different contexts, which is more intuitive than creating tools.
