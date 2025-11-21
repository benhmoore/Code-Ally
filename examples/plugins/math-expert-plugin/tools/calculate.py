#!/usr/bin/env python3
import json
import sys
import ast
import math
import operator

# Define allowed operations and functions
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
        """Evaluate an AST node safely."""
        method_name = f'eval_{type(node).__name__}'
        method = getattr(self, method_name, None)
        if method is None:
            raise ValueError(f"Unsupported operation: {type(node).__name__}")
        return method(node)

    def eval_Expression(self, node):
        """Evaluate an Expression node."""
        return self.evaluate(node.body)

    def eval_Constant(self, node):
        """Evaluate a Constant (number)."""
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError(f"Unsupported constant type: {type(node.value).__name__}")

    def eval_Num(self, node):
        """Evaluate a Num node (for older Python versions)."""
        return node.n

    def eval_BinOp(self, node):
        """Evaluate a binary operation."""
        op_type = type(node.op)
        if op_type not in ALLOWED_OPS:
            raise ValueError(f"Unsupported binary operation: {op_type.__name__}")

        left = self.evaluate(node.left)
        right = self.evaluate(node.right)
        op_func = ALLOWED_OPS[op_type]

        # Handle division by zero
        if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
            raise ZeroDivisionError("Division by zero")

        return op_func(left, right)

    def eval_UnaryOp(self, node):
        """Evaluate a unary operation."""
        op_type = type(node.op)
        if op_type not in ALLOWED_OPS:
            raise ValueError(f"Unsupported unary operation: {op_type.__name__}")

        operand = self.evaluate(node.operand)
        op_func = ALLOWED_OPS[op_type]
        return op_func(operand)

    def eval_Call(self, node):
        """Evaluate a function call."""
        if not isinstance(node.func, ast.Name):
            raise ValueError("Only simple function calls are allowed")

        func_name = node.func.id
        if func_name not in ALLOWED_FUNCTIONS:
            raise ValueError(f"Unsupported function: {func_name}")

        # Evaluate arguments
        args = [self.evaluate(arg) for arg in node.args]

        # Call the function
        func = ALLOWED_FUNCTIONS[func_name]
        try:
            return func(*args)
        except Exception as e:
            raise ValueError(f"Error calling {func_name}: {str(e)}")

    def eval_Name(self, node):
        """Evaluate a name (constant)."""
        if node.id not in ALLOWED_CONSTANTS:
            raise ValueError(f"Unsupported constant: {node.id}")
        return ALLOWED_CONSTANTS[node.id]

def safe_evaluate(expression):
    """
    Safely evaluate a mathematical expression.

    Args:
        expression: String containing the mathematical expression

    Returns:
        The evaluated result

    Raises:
        ValueError: If the expression contains invalid operations
        ZeroDivisionError: If division by zero is attempted
        SyntaxError: If the expression has syntax errors
    """
    # Pre-process: Replace ^ with ** for exponentiation
    # (^ is bitwise XOR in Python, but commonly used for exponents in math notation)
    expression = expression.replace('^', '**')

    # Parse the expression into an AST
    try:
        tree = ast.parse(expression, mode='eval')
    except SyntaxError as e:
        raise SyntaxError(f"Invalid expression syntax: {str(e)}")

    # Evaluate the AST safely
    evaluator = SafeEvaluator()
    return evaluator.evaluate(tree)

def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        expression = input_data.get('expression')

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

        # Evaluate the expression safely
        result = safe_evaluate(expression.strip())

        # Return result
        print(json.dumps({
            "success": True,
            "result": result,
            "expression": expression.strip()
        }))

    except ZeroDivisionError:
        print(json.dumps({
            "success": False,
            "error": "Division by zero"
        }))
        sys.exit(1)

    except ValueError as e:
        error_msg = str(e)
        if "Unsupported" in error_msg or "Invalid" in error_msg:
            print(json.dumps({
                "success": False,
                "error": f"Invalid expression: only mathematical operations allowed. {error_msg}"
            }))
        else:
            print(json.dumps({
                "success": False,
                "error": error_msg
            }))
        sys.exit(1)

    except SyntaxError as e:
        print(json.dumps({
            "success": False,
            "error": f"Syntax error in expression: {str(e)}"
        }))
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
