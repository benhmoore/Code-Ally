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
    # Also allow ' for derivatives (e.g., f'(x)) and = for equations
    allowed_pattern = r"^[a-zA-Z0-9\+\-\*/\(\)\.\,\s\^\%'=]+$"
    if not re.match(allowed_pattern, expr_str):
        raise ValueError("Invalid expression: contains forbidden characters")


def solve_ode(equation_str, function_name='f', variable_str='x'):
    """
    Solve an ordinary differential equation symbolically using SymPy.

    Args:
        equation_str: String containing the ODE (e.g., "f'(x) + 2*f(x) = 0" or "Derivative(f(x), x) + 2*f(x) = 0")
        function_name: Name of the function to solve for (default: 'f')
        variable_str: Independent variable (default: 'x')

    Returns:
        Dictionary containing success status and solution
    """
    try:
        # Validate expression
        validate_expression(equation_str)

        # Define symbols and function
        variable = sympy.Symbol(variable_str)
        func = sympy.Function(function_name)

        # Parse the equation
        # Support both f'(x) notation and Derivative(f(x), x) notation
        # Replace f'(x) with Derivative(f(x), x) for parsing
        equation_normalized = equation_str

        # Handle f'(x), f''(x), etc.
        equation_normalized = re.sub(
            rf"{function_name}''''\({variable_str}\)",
            f"Derivative({function_name}({variable_str}), {variable_str}, 4)",
            equation_normalized
        )
        equation_normalized = re.sub(
            rf"{function_name}'''\({variable_str}\)",
            f"Derivative({function_name}({variable_str}), {variable_str}, 3)",
            equation_normalized
        )
        equation_normalized = re.sub(
            rf"{function_name}''\({variable_str}\)",
            f"Derivative({function_name}({variable_str}), {variable_str}, 2)",
            equation_normalized
        )
        equation_normalized = re.sub(
            rf"{function_name}'\({variable_str}\)",
            f"Derivative({function_name}({variable_str}), {variable_str})",
            equation_normalized
        )

        # Check for equation sign
        if '=' not in equation_normalized:
            raise ValueError("Equation must contain '=' sign")

        parts = equation_normalized.split('=')
        if len(parts) != 2:
            raise ValueError("Equation must contain exactly one '=' sign")

        left_str, right_str = parts[0].strip(), parts[1].strip()

        if not left_str or not right_str:
            raise ValueError("Both sides of the equation must be non-empty")

        # Parse both sides
        safe_locals = {function_name: func, variable_str: variable}
        left_expr = sympy.sympify(left_str, locals=safe_locals)
        right_expr = sympy.sympify(right_str, locals=safe_locals)

        # Create equation as left - right = 0
        equation = sympy.Eq(left_expr, right_expr)

        # Solve the ODE
        solution = sympy.dsolve(equation, func(variable))

        # Simplify the solution
        simplified_solution = sympy.simplify(solution)

        return {
            "success": True,
            "solution": str(simplified_solution),
            "equation": equation_str,
            "function": function_name,
            "variable": variable_str,
            "solution_type": "general_solution"
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error solving ODE: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        equation = input_data.get('equation')
        function = input_data.get('function', 'f')
        variable = input_data.get('variable', 'x')

        # Validate inputs
        if equation is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'equation'"
            }))
            sys.exit(1)

        if not isinstance(equation, str) or not equation.strip():
            print(json.dumps({
                "success": False,
                "error": "Equation must be a non-empty string"
            }))
            sys.exit(1)

        if not isinstance(function, str) or not function.strip():
            print(json.dumps({
                "success": False,
                "error": "Function must be a non-empty string"
            }))
            sys.exit(1)

        if not isinstance(variable, str) or not variable.strip():
            print(json.dumps({
                "success": False,
                "error": "Variable must be a non-empty string"
            }))
            sys.exit(1)

        # Solve the ODE
        result = solve_ode(equation.strip(), function.strip(), variable.strip())

        # Return result
        print(json.dumps(result))

        # Exit with error code if solving failed
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
