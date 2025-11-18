# Math Expert Plugin

A complete example plugin demonstrating the plugin agent feature with contextual tools. This plugin provides a specialized `math-expert` agent with exclusive access to four arithmetic calculation tools.

## Overview

This plugin showcases how to:
- Define a custom agent with specialized capabilities
- Create contextual tools that are only accessible to specific agents
- Bind tools to agents using `visible_to` constraints
- Implement a focused AI agent for domain-specific tasks

## Plugin Components

### Agent: `math-expert`

A specialized mathematician agent configured to:
- Solve arithmetic problems methodically
- Break down complex calculations into simple steps
- Use precision calculation tools rather than mental math
- Show work and explain reasoning clearly

**Configuration:**
- Temperature: 0.3 (for precise, consistent calculations)
- Reasoning effort: medium
- Exclusive tools: add, subtract, multiply, divide

### Tools

All four tools are **contextual** - they can only be used by the `math-expert` agent due to the `visible_to: ["math-expert"]` constraint in the manifest.

#### `add`
Add two numbers together.

**Input:**
```json
{
  "a": 15,
  "b": 8
}
```

**Output:**
```json
{
  "success": true,
  "result": 23,
  "operation": "15 + 8 = 23"
}
```

#### `subtract`
Subtract one number from another.

**Input:**
```json
{
  "a": 50,
  "b": 17
}
```

**Output:**
```json
{
  "success": true,
  "result": 33,
  "operation": "50 - 17 = 33"
}
```

#### `multiply`
Multiply two numbers together.

**Input:**
```json
{
  "a": 12,
  "b": 7
}
```

**Output:**
```json
{
  "success": true,
  "result": 84,
  "operation": "12 × 7 = 84"
}
```

#### `divide`
Divide one number by another.

**Input:**
```json
{
  "a": 100,
  "b": 4
}
```

**Output:**
```json
{
  "success": true,
  "result": 25.0,
  "operation": "100 ÷ 4 = 25.0"
}
```

**Error handling:**
- Division by zero returns an error
- All tools validate required parameters
- Invalid JSON input is handled gracefully

## Installation

1. Copy the entire `math-expert-plugin` directory to your plugins folder
2. Install Python dependencies (required for equation solving):
   ```bash
   cd math-expert-plugin
   pip3 install -r requirements.txt
   ```
3. Load the plugin in your configuration
4. The `math-expert` agent and its tools will become available

**Dependencies:**
- Python 3.x
- SymPy 1.12+ (for symbolic equation solving)

## Usage Examples

### Simple Calculation

```
User: Hey math-expert, what is 156 + 247?

Math Expert: I'll add those numbers for you.
[Uses add tool with a=156, b=247]
The result is 403.
```

### Complex Multi-Step Problem

```
User: math-expert, calculate (85 - 12) × 4

Math Expert: I'll solve this step by step:

Step 1: Calculate 85 - 12
[Uses subtract tool with a=85, b=12]
Result: 73

Step 2: Multiply 73 by 4
[Uses multiply tool with a=73, b=4]
Result: 292

Final answer: (85 - 12) × 4 = 292
```

### Division with Validation

```
User: math-expert, divide 200 by 8

Math Expert: I'll perform the division.
[Uses divide tool with a=200, b=8]
The result is 25.0
```

## Implementation Details

### Tool-Agent Binding

The key feature demonstrated here is **contextual tools**. In `plugin.json`, each tool specifies:

```json
{
  "name": "add",
  "visible_to": ["math-expert"],
  ...
}
```

This ensures that:
1. Only the `math-expert` agent can call these tools
2. Other agents in the system cannot access them
3. Empty or missing `visible_to` array would make the tool visible to all agents
3. The tools appear only when the math-expert agent is active

### Agent Tool Restriction

The agent definition also restricts which tools it can use:

```json
{
  "name": "math-expert",
  "tools": ["add", "subtract", "multiply", "divide"]
}
```

This creates a two-way binding:
- Tools require the specific agent
- Agent is limited to specific tools

### System Prompt Design

The agent's system prompt (in `agents/math-expert.md`) is designed to:
- Clearly identify available tools
- Provide guidelines for when and how to use them
- Encourage showing work and explaining reasoning
- Promote methodical problem-solving

## File Structure

```
math-expert-plugin/
├── plugin.json                 # Plugin manifest with tools and agent
├── agents/
│   └── math-expert.md         # Agent definition and system prompt
├── tools/
│   ├── add.py                 # Addition tool
│   ├── subtract.py            # Subtraction tool
│   ├── multiply.py            # Multiplication tool
│   └── divide.py              # Division tool
└── README.md                  # This file
```

## For Plugin Developers

This plugin serves as a reference implementation showing:

1. **How to define an agent in plugin.json:**
   - Set name, description, and system_prompt_file
   - Specify which tools the agent can access
   - Configure agent parameters (temperature, reasoning effort)

2. **How to create contextual tools:**
   - Add `visible_to` field with agent array to tool definitions
   - Tools become exclusive to agents in the array
   - Prevents tool access from other contexts
   - Empty or missing array = visible to all agents

3. **How to write agent system prompts:**
   - Use YAML frontmatter for metadata
   - Write clear instructions for the agent's role
   - Explain available tools and when to use them
   - Provide examples of good behavior

4. **How to implement tool executables:**
   - Read JSON from stdin
   - Validate input parameters
   - Perform operations with error handling
   - Return JSON output with success/error states

## Testing the Plugin

You can test the tools directly from the command line:

```bash
# Test addition
echo '{"a": 10, "b": 5}' | python3 tools/add.py

# Test subtraction
echo '{"a": 20, "b": 8}' | python3 tools/subtract.py

# Test multiplication
echo '{"a": 6, "b": 7}' | python3 tools/multiply.py

# Test division
echo '{"a": 100, "b": 4}' | python3 tools/divide.py

# Test error handling (division by zero)
echo '{"a": 10, "b": 0}' | python3 tools/divide.py
```

## License

This is an example plugin provided by the Claude Code team for educational purposes.
