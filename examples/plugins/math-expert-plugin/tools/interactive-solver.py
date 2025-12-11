#!/usr/bin/env python3
"""
Interactive Solver Tool

Presents a form to the user to enter/confirm a mathematical expression,
then evaluates it and returns the result. Supports prefilling the expression
when the agent provides one.

Uses the plugin form request protocol:
1. Output JSON with __ally_form_request to stdout
2. Read form response from stdin
3. Process and return result
"""
import json
import sys
import ast
import math
import operator

# Define allowed operations and functions (same as calculate.py)
ALLOWED_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

ALLOWED_FUNCTIONS = {
    'sqrt': math.sqrt,
    'sin': math.sin,
    'cos': math.cos,
    'tan': math.tan,
    'log': math.log,
    'log10': math.log10,
    'exp': math.exp,
    'abs': abs,
    'ceil': math.ceil,
    'floor': math.floor,
}

ALLOWED_CONSTANTS = {
    'pi': math.pi,
    'e': math.e,
}


class SafeEvaluator(ast.NodeVisitor):
    """Safe expression evaluator using AST parsing."""

    def evaluate(self, node):
        method_name = f'eval_{type(node).__name__}'
        method = getattr(self, method_name, None)
        if method is None:
            raise ValueError(f"Unsupported operation: {type(node).__name__}")
        return method(node)

    def eval_Expression(self, node):
        return self.evaluate(node.body)

    def eval_Constant(self, node):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError(f"Unsupported constant type: {type(node.value).__name__}")

    def eval_Num(self, node):
        return node.n

    def eval_BinOp(self, node):
        op_type = type(node.op)
        if op_type not in ALLOWED_OPS:
            raise ValueError(f"Unsupported binary operation: {op_type.__name__}")
        left = self.evaluate(node.left)
        right = self.evaluate(node.right)
        op_func = ALLOWED_OPS[op_type]
        if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
            raise ZeroDivisionError("Division by zero")
        return op_func(left, right)

    def eval_UnaryOp(self, node):
        op_type = type(node.op)
        if op_type not in ALLOWED_OPS:
            raise ValueError(f"Unsupported unary operation: {op_type.__name__}")
        operand = self.evaluate(node.operand)
        op_func = ALLOWED_OPS[op_type]
        return op_func(operand)

    def eval_Call(self, node):
        if not isinstance(node.func, ast.Name):
            raise ValueError("Only simple function calls are allowed")
        func_name = node.func.id
        if func_name not in ALLOWED_FUNCTIONS:
            raise ValueError(f"Unsupported function: {func_name}")
        args = [self.evaluate(arg) for arg in node.args]
        func = ALLOWED_FUNCTIONS[func_name]
        try:
            return func(*args)
        except Exception as e:
            raise ValueError(f"Error calling {func_name}: {str(e)}")

    def eval_Name(self, node):
        if node.id not in ALLOWED_CONSTANTS:
            raise ValueError(f"Unsupported constant: {node.id}")
        return ALLOWED_CONSTANTS[node.id]


def safe_evaluate(expression):
    """Safely evaluate a mathematical expression."""
    expression = expression.replace('^', '**')
    try:
        tree = ast.parse(expression, mode='eval')
    except SyntaxError as e:
        raise SyntaxError(f"Invalid expression syntax: {str(e)}")
    evaluator = SafeEvaluator()
    return evaluator.evaluate(tree)


def request_form(initial_values=None):
    """
    Request a form from the user via the plugin form protocol.

    Outputs a JSON form request to stdout and reads the response from stdin.
    Demonstrates all available field types: string, number, boolean, choice.
    """
    form_request = {
        "__ally_form_request": True,
        "schema": {
            "title": "Interactive Math Solver",
            "description": "Configure and evaluate a mathematical expression.",
            "fields": [
                {
                    "name": "expression",
                    "type": "string",
                    "label": "Expression",
                    "description": "e.g., '2 * (3 + 4)', 'sqrt(16) + pi'",
                    "required": True
                },
                {
                    "name": "precision",
                    "type": "number",
                    "label": "Decimal Places",
                    "description": "Number of decimal places (0-10)",
                    "default": 4,
                    "validation": {
                        "min": 0,
                        "max": 10
                    }
                },
                {
                    "name": "format",
                    "type": "choice",
                    "label": "Output Format",
                    "choices": [
                        {"value": "decimal", "label": "Decimal"},
                        {"value": "scientific", "label": "Scientific"},
                        {"value": "fraction", "label": "Fraction (if possible)"}
                    ],
                    "default": "decimal"
                },
                {
                    "name": "show_steps",
                    "type": "boolean",
                    "label": "Show Steps",
                    "description": "Include intermediate steps in output",
                    "default": False
                }
            ]
        },
        "initialValues": initial_values or {}
    }

    # Send form request to stdout
    print(json.dumps(form_request), flush=True)

    # Read response from stdin
    response_line = sys.stdin.readline()
    if not response_line:
        raise RuntimeError("No response received from form")

    response = json.loads(response_line)

    if not response.get("__ally_form_response"):
        raise RuntimeError("Invalid form response")

    if not response.get("success"):
        if response.get("cancelled"):
            return None  # User cancelled
        raise RuntimeError(response.get("error", "Form submission failed"))

    return response.get("data", {})


def format_result(result, fmt, precision):
    """Format the result according to user preferences."""
    if fmt == "scientific":
        return f"{result:.{precision}e}"
    elif fmt == "fraction":
        # Try to represent as fraction if it's close to a simple fraction
        from fractions import Fraction
        try:
            frac = Fraction(result).limit_denominator(1000)
            if abs(float(frac) - result) < 1e-9:
                return str(frac)
        except (ValueError, OverflowError):
            pass
        return f"{result:.{precision}f}"
    else:  # decimal
        return f"{result:.{precision}f}"


def main():
    try:
        # Read initial input from stdin (tool arguments)
        # Use readline() instead of json.load() because stdin stays open for form responses
        input_line = sys.stdin.readline()
        input_data = json.loads(input_line) if input_line.strip() else {}

        # Build initial values from tool arguments
        initial_values = {}
        if input_data.get('expression'):
            initial_values['expression'] = input_data['expression']

        # Request form from user
        form_data = request_form(initial_values)

        if form_data is None:
            # User cancelled the form
            print(json.dumps({
                "success": False,
                "error": "Calculation cancelled by user"
            }))
            sys.exit(0)

        # Extract form values
        expression = form_data.get('expression', '').strip()
        precision = int(form_data.get('precision', 4))
        output_format = form_data.get('format', 'decimal')
        show_steps = form_data.get('show_steps', False)

        if not expression:
            print(json.dumps({
                "success": False,
                "error": "No expression provided"
            }))
            sys.exit(1)

        # Evaluate the expression
        result = safe_evaluate(expression)

        # Format the result
        formatted = format_result(result, output_format, precision)

        # Build response
        response = {
            "success": True,
            "expression": expression,
            "result": result,
            "formatted": formatted,
            "format": output_format,
            "precision": precision
        }

        # Add steps if requested
        if show_steps:
            response["steps"] = [
                f"1. Parse expression: {expression}",
                f"2. Evaluate: {result}",
                f"3. Format as {output_format}: {formatted}"
            ]
            response["message"] = f"{expression} = {formatted} (with steps)"
        else:
            response["message"] = f"{expression} = {formatted}"

        print(json.dumps(response))

    except ZeroDivisionError:
        print(json.dumps({
            "success": False,
            "error": "Division by zero"
        }))
        sys.exit(1)

    except ValueError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid expression: {str(e)}"
        }))
        sys.exit(1)

    except SyntaxError as e:
        print(json.dumps({
            "success": False,
            "error": f"Syntax error: {str(e)}"
        }))
        sys.exit(1)

    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON: {str(e)}"
        }))
        sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Error: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
