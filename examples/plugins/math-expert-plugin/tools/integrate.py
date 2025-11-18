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


def integrate_expression(expression_str, variable_str='x', lower_bound=None, upper_bound=None):
    """
    Integrate a mathematical expression symbolically using SymPy.

    Args:
        expression_str: String containing the mathematical expression
        variable_str: String representing the variable to integrate with respect to
        lower_bound: Optional lower bound for definite integral (string or number)
        upper_bound: Optional upper bound for definite integral (string or number)

    Returns:
        Dictionary containing success status and integral
    """
    try:
        # Validate expression
        validate_expression(expression_str)

        # Parse the expression using SymPy with restricted namespace
        safe_locals = {}
        expr = sympy.sympify(expression_str, locals=safe_locals)

        # Define the variable
        variable = sympy.Symbol(variable_str)

        # Check if this is a definite or indefinite integral
        if lower_bound is not None and upper_bound is not None:
            # Definite integral
            # Parse bounds (they can be numbers or expressions)
            if isinstance(lower_bound, str):
                validate_expression(lower_bound)
                lower = sympy.sympify(lower_bound, locals=safe_locals)
            else:
                lower = lower_bound

            if isinstance(upper_bound, str):
                validate_expression(upper_bound)
                upper = sympy.sympify(upper_bound, locals=safe_locals)
            else:
                upper = upper_bound

            # Compute definite integral
            integral = sympy.integrate(expr, (variable, lower, upper))

            # Simplify the result
            simplified = sympy.simplify(integral)

            # Try to get numerical value if possible
            try:
                numerical = float(simplified.evalf())
                return {
                    "success": True,
                    "integral": str(simplified),
                    "numerical_value": numerical,
                    "expression": expression_str,
                    "variable": variable_str,
                    "lower_bound": str(lower),
                    "upper_bound": str(upper),
                    "type": "definite"
                }
            except:
                return {
                    "success": True,
                    "integral": str(simplified),
                    "expression": expression_str,
                    "variable": variable_str,
                    "lower_bound": str(lower),
                    "upper_bound": str(upper),
                    "type": "definite"
                }

        else:
            # Indefinite integral
            integral = sympy.integrate(expr, variable)

            # Simplify the result
            simplified = sympy.simplify(integral)

            return {
                "success": True,
                "integral": str(simplified) + " + C",
                "expression": expression_str,
                "variable": variable_str,
                "type": "indefinite"
            }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing integral: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        expression = input_data.get('expression')
        variable = input_data.get('variable', 'x')
        lower_bound = input_data.get('lower_bound')
        upper_bound = input_data.get('upper_bound')

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

        # Check that bounds are either both provided or both missing
        if (lower_bound is None) != (upper_bound is None):
            print(json.dumps({
                "success": False,
                "error": "Both lower_bound and upper_bound must be provided for definite integral, or both omitted for indefinite integral"
            }))
            sys.exit(1)

        # Compute the integral
        result = integrate_expression(expression.strip(), variable.strip(), lower_bound, upper_bound)

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
