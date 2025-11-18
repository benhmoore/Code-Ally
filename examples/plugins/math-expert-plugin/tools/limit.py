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


def compute_limit(expression_str, variable_str='x', point='0', direction=None):
    """
    Compute the limit of a mathematical expression using SymPy.

    Args:
        expression_str: String containing the mathematical expression
        variable_str: String representing the variable
        point: Point to evaluate the limit at (can be a number, 'inf', or '-inf')
        direction: Direction of the limit ('+' for right, '-' for left, None for both)

    Returns:
        Dictionary containing success status and limit
    """
    try:
        # Validate expression
        validate_expression(expression_str)

        # Parse the expression using SymPy with restricted namespace
        safe_locals = {}
        expr = sympy.sympify(expression_str, locals=safe_locals)

        # Define the variable
        variable = sympy.Symbol(variable_str)

        # Parse the point
        if isinstance(point, str):
            point_str = point.strip().lower()
            if point_str == 'inf' or point_str == 'infinity':
                limit_point = sympy.oo
            elif point_str == '-inf' or point_str == '-infinity':
                limit_point = -sympy.oo
            else:
                # Validate and parse as expression
                validate_expression(point)
                limit_point = sympy.sympify(point, locals=safe_locals)
        else:
            limit_point = point

        # Determine direction
        if direction is not None:
            direction_str = str(direction).strip()
            if direction_str == '+' or direction_str == 'right':
                dir_arg = '+'
            elif direction_str == '-' or direction_str == 'left':
                dir_arg = '-'
            else:
                raise ValueError(f"Invalid direction '{direction}'. Use '+' for right, '-' for left, or omit for two-sided limit")
        else:
            dir_arg = None

        # Compute the limit
        if dir_arg:
            result = sympy.limit(expr, variable, limit_point, dir=dir_arg)
        else:
            result = sympy.limit(expr, variable, limit_point)

        # Format the result
        result_str = str(result)

        # Try to get numerical value if possible and finite
        numerical = None
        if result.is_number:
            try:
                numerical = float(result.evalf())
            except:
                pass

        return {
            "success": True,
            "limit": result_str,
            "numerical_value": numerical,
            "expression": expression_str,
            "variable": variable_str,
            "point": str(limit_point),
            "direction": direction if direction else "two-sided"
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing limit: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        expression = input_data.get('expression')
        variable = input_data.get('variable', 'x')
        point = input_data.get('point', '0')
        direction = input_data.get('direction')

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

        # Compute the limit
        result = compute_limit(expression.strip(), variable.strip(), point, direction)

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
