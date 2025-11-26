#!/usr/bin/env python3
import json
import sys
import re

try:
    import sympy
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "SymPy is not installed. Please install it using: pip install sympy"
    }))
    sys.exit(1)


def validate_expression(expr_str):
    """
    Validate that an expression string is safe for sympify.

    Prevents code execution by checking for dangerous patterns before parsing.

    Args:
        expr_str: Expression string to validate

    Raises:
        ValueError: If expression contains dangerous patterns
    """
    # Remove whitespace for checking
    check_str = expr_str.replace(' ', '')

    # Block common code execution patterns
    dangerous_patterns = [
        '__', 'import', 'exec', 'eval', 'compile', 'open', 'file',
        'input', 'raw_input', 'globals', 'locals', 'vars', 'dir',
        'getattr', 'setattr', 'delattr', 'hasattr', 'callable',
        'classmethod', 'staticmethod', 'property', 'lambda'
    ]

    for pattern in dangerous_patterns:
        if pattern in check_str.lower():
            raise ValueError(f"Invalid expression: contains forbidden pattern '{pattern}'")

    # Allow only: letters, numbers, basic operators, parentheses, and common math functions
    allowed_pattern = r'^[a-zA-Z0-9\+\-\*/\(\)\.\,\s\^\%]+$'
    if not re.match(allowed_pattern, expr_str):
        raise ValueError("Invalid expression: contains forbidden characters")


def differentiate_expression(expression_str, variable_str='x', order=1):
    """
    Differentiate a mathematical expression symbolically using SymPy.

    Args:
        expression_str: String containing the mathematical expression
        variable_str: String representing the variable to differentiate with respect to
        order: Order of derivative (1 for first derivative, 2 for second, etc.)

    Returns:
        Dictionary containing success status and derivative
    """
    try:
        # Validate expression
        validate_expression(expression_str)

        # Parse the expression using SymPy with restricted namespace
        safe_locals = {}
        expr = sympy.sympify(expression_str, locals=safe_locals)

        # Define the variable
        variable = sympy.Symbol(variable_str)

        # Compute the derivative
        derivative = sympy.diff(expr, variable, order)

        # Simplify the result
        simplified = sympy.simplify(derivative)

        return {
            "success": True,
            "derivative": str(simplified),
            "expression": expression_str,
            "variable": variable_str,
            "order": order
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing derivative: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        expression = input_data.get('expression')
        variable = input_data.get('variable', 'x')
        order = input_data.get('order', 1)

        # Validate inputs
        if expression is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'expression'"
            }))
            sys.exit(1)

        if not isinstance(expression, str) or not expression.strip():
            print(json.dumps({
                "success": False,
                "error": "Expression must be a non-empty string"
            }))
            sys.exit(1)

        if not isinstance(variable, str) or not variable.strip():
            print(json.dumps({
                "success": False,
                "error": "Variable must be a non-empty string"
            }))
            sys.exit(1)

        if not isinstance(order, int) or order < 1:
            print(json.dumps({
                "success": False,
                "error": "Order must be a positive integer"
            }))
            sys.exit(1)

        # Compute the derivative
        result = differentiate_expression(expression.strip(), variable.strip(), order)

        # Return result
        print(json.dumps(result))

        # Exit with error code if computation failed
        if not result.get("success", False):
            sys.exit(1)

    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON input: {str(e)}"
        }))
        sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Unexpected error: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
