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
    # This regex allows: a-z, A-Z, 0-9, +, -, *, /, **, //, %, ^, (), ., ,, spaces
    # Plus common function names: sin, cos, tan, log, exp, sqrt, abs, etc.
    allowed_pattern = r'^[a-zA-Z0-9\+\-\*/\(\)\.\,\s\^\%]+$'
    if not re.match(allowed_pattern, expr_str):
        raise ValueError("Invalid expression: contains forbidden characters")


def parse_equation(equation_str):
    """
    Parse an equation string into left and right hand sides.

    Args:
        equation_str: String containing the equation (e.g., "2*x + 3 = 7")

    Returns:
        Tuple of (left_expr, right_expr) as SymPy expressions

    Raises:
        ValueError: If the equation format is invalid
    """
    if '=' not in equation_str:
        raise ValueError("Equation must contain '=' sign")

    parts = equation_str.split('=')
    if len(parts) != 2:
        raise ValueError("Equation must contain exactly one '=' sign")

    left_str, right_str = parts[0].strip(), parts[1].strip()

    if not left_str or not right_str:
        raise ValueError("Both sides of the equation must be non-empty")

    # Validate both sides before parsing
    validate_expression(left_str)
    validate_expression(right_str)

    try:
        # Use sympify with restricted namespace to prevent code execution
        # Empty locals dict prevents access to global namespace
        safe_locals = {}
        left_expr = sympy.sympify(left_str, locals=safe_locals)
        right_expr = sympy.sympify(right_str, locals=safe_locals)
    except Exception as e:
        raise ValueError(f"Invalid equation syntax: {str(e)}")

    return left_expr, right_expr


def format_solution(solution):
    """
    Format a solution for human-readable output.

    Args:
        solution: SymPy expression or value

    Returns:
        String representation of the solution
    """
    if isinstance(solution, (sympy.I.__class__, sympy.ComplexRootOf)):
        return str(solution)
    elif isinstance(solution, sympy.Rational):
        # Return as fraction if not a whole number
        if solution.q != 1:
            return f"{solution.p}/{solution.q}"
        return str(solution.p)
    elif isinstance(solution, (int, float)):
        return str(solution)
    else:
        return str(solution)


def solve_equation_symbolic(equation_str, variable_str='x'):
    """
    Solve an algebraic equation symbolically using SymPy.

    Args:
        equation_str: String containing the equation (e.g., "2*x + 3 = 7")
        variable_str: String representing the variable to solve for (default: 'x')

    Returns:
        Dictionary containing success status and solutions
    """
    try:
        # Parse the equation
        left_expr, right_expr = parse_equation(equation_str)

        # Create the equation as left - right = 0
        equation = left_expr - right_expr

        # Define the variable
        variable = sympy.Symbol(variable_str)

        # Solve the equation
        solutions = sympy.solve(equation, variable)

        # Handle different solution types
        if isinstance(solutions, list):
            if len(solutions) == 0:
                # No solutions
                return {
                    "success": True,
                    "solutions": [],
                    "equation": equation_str,
                    "variable": variable_str,
                    "message": "No solutions found"
                }
            else:
                # Format solutions
                formatted_solutions = [format_solution(sol) for sol in solutions]
                return {
                    "success": True,
                    "solutions": formatted_solutions,
                    "equation": equation_str,
                    "variable": variable_str
                }
        elif isinstance(solutions, dict):
            # System of equations or parametric solutions
            formatted_solutions = {str(k): format_solution(v) for k, v in solutions.items()}
            return {
                "success": True,
                "solutions": formatted_solutions,
                "equation": equation_str,
                "variable": variable_str
            }
        elif solutions == True or solutions == sympy.S.Reals:
            # Identity - all real numbers are solutions
            return {
                "success": True,
                "solutions": "all real numbers",
                "equation": equation_str,
                "variable": variable_str,
                "message": "The equation is an identity (true for all real numbers)"
            }
        elif solutions == False or solutions == sympy.S.EmptySet:
            # No solutions
            return {
                "success": True,
                "solutions": [],
                "equation": equation_str,
                "variable": variable_str,
                "message": "No solutions found"
            }
        else:
            # Single solution or other format
            return {
                "success": True,
                "solutions": [format_solution(solutions)],
                "equation": equation_str,
                "variable": variable_str
            }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error solving equation: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        equation = input_data.get('equation')
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

        if not isinstance(variable, str) or not variable.strip():
            print(json.dumps({
                "success": False,
                "error": "Variable must be a non-empty string"
            }))
            sys.exit(1)

        # Solve the equation
        result = solve_equation_symbolic(equation.strip(), variable.strip())

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
