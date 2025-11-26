# Math Expert Plugin

A plugin providing a specialized math agent with calculation, equation solving, calculus, linear algebra, and differential equation tools.

## Overview

This plugin demonstrates:
- Custom agent with specialized system prompt
- Tool-agent binding using `visible_to`
- Agent requirements to prevent hallucination
- Multiple related tools in a single plugin

## Agent: `math-expert`

A mathematician agent configured for precise calculations.

**Configuration:**
- Temperature: 0.3
- Reasoning effort: medium
- 16 specialized tools

## Tools

All tools use `visible_to: ["math-expert"]` - only the math-expert agent can call them.

### Basic Arithmetic
- `add` - Add two numbers
- `subtract` - Subtract two numbers
- `multiply` - Multiply two numbers
- `divide` - Divide two numbers

### Advanced Calculation
- `calculate` - Evaluate complex expressions (sqrt, sin, cos, log, etc.)
- `solve-equation` - Solve algebraic equations symbolically

### Calculus
- `differentiate` - Compute derivatives
- `integrate` - Compute integrals (definite and indefinite)
- `limit` - Compute limits

### Linear Algebra
- `matrix-determinant` - Compute determinant
- `matrix-inverse` - Compute matrix inverse
- `matrix-multiply` - Multiply matrices
- `matrix-eigenvalues` - Compute eigenvalues/eigenvectors

### Differential Equations
- `solve-ode` - Solve ODEs (general solution)
- `solve-ode-ivp` - Solve ODE initial value problems

### Utility
- `cannot-calculate` - Report when calculation is not possible

## Installation

```bash
# Copy to plugins directory
cp -r examples/plugins/math-expert-plugin ~/.ally/profiles/default/plugins/

# Dependencies install automatically on first load
```

**Requirements:**
- Python 3.x
- SymPy (installed automatically)

## Usage

```
User: math-expert, what is the derivative of x^3?

Math Expert: [Uses differentiate tool]
The derivative of x³ is 3x².
```

## File Structure

```
math-expert-plugin/
├── plugin.json           # Manifest with 16 tools and agent
├── agents/
│   └── math-expert.md    # Agent system prompt
├── tools/
│   ├── add.py
│   ├── subtract.py
│   ├── multiply.py
│   ├── divide.py
│   ├── calculate.py
│   ├── solve_equation.py
│   ├── differentiate.py
│   ├── integrate.py
│   ├── limit.py
│   ├── matrix_determinant.py
│   ├── matrix_inverse.py
│   ├── matrix_multiply.py
│   ├── matrix_eigenvalues.py
│   ├── solve_ode.py
│   ├── solve_ode_ivp.py
│   └── cannot_calculate.py
├── requirements.txt
└── README.md
```

## Testing

```bash
# Test basic arithmetic
echo '{"a": 10, "b": 5}' | python3 tools/add.py

# Test expression evaluation
echo '{"expression": "sqrt(144) + 2**3"}' | python3 tools/calculate.py

# Test differentiation
echo '{"expression": "x**3", "variable": "x"}' | python3 tools/differentiate.py
```
