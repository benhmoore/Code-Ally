#!/usr/bin/env python3
import json
import sys

try:
    import sympy
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "SymPy is not installed. Please install it using: pip install sympy"
    }))
    sys.exit(1)


def multiply_matrices(matrix_a_data, matrix_b_data):
    """
    Multiply two matrices using SymPy.

    Args:
        matrix_a_data: 2D list representing first matrix
        matrix_b_data: 2D list representing second matrix

    Returns:
        Dictionary containing success status and product matrix
    """
    try:
        # Validate matrix inputs
        if not matrix_a_data or not isinstance(matrix_a_data, list):
            raise ValueError("matrix_a must be a 2D array (list of lists)")

        if not matrix_b_data or not isinstance(matrix_b_data, list):
            raise ValueError("matrix_b must be a 2D array (list of lists)")

        if not all(isinstance(row, list) for row in matrix_a_data):
            raise ValueError("matrix_a must be a 2D array (each row must be a list)")

        if not all(isinstance(row, list) for row in matrix_b_data):
            raise ValueError("matrix_b must be a 2D array (each row must be a list)")

        # Create SymPy matrices
        matrix_a = sympy.Matrix(matrix_a_data)
        matrix_b = sympy.Matrix(matrix_b_data)

        # Size limit for performance
        if matrix_a.rows > 10 or matrix_a.cols > 10 or matrix_b.rows > 10 or matrix_b.cols > 10:
            raise ValueError("Matrix dimensions limited to 10×10 for performance reasons")

        # Check dimension compatibility for multiplication
        if matrix_a.cols != matrix_b.rows:
            raise ValueError(
                f"Cannot multiply matrices: matrix_a columns ({matrix_a.cols}) "
                f"must equal matrix_b rows ({matrix_b.rows})"
            )

        # Perform matrix multiplication
        product = matrix_a * matrix_b

        # Convert result to list format
        result_matrix = [[str(sympy.simplify(product[i, j])) for j in range(product.cols)]
                        for i in range(product.rows)]

        return {
            "success": True,
            "product": result_matrix,
            "matrix_a_size": f"{matrix_a.rows}×{matrix_a.cols}",
            "matrix_b_size": f"{matrix_b.rows}×{matrix_b.cols}",
            "result_size": f"{product.rows}×{product.cols}"
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error multiplying matrices: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        matrix_a = input_data.get('matrix_a')
        matrix_b = input_data.get('matrix_b')

        # Validate inputs
        if matrix_a is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'matrix_a'"
            }))
            sys.exit(1)

        if matrix_b is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'matrix_b'"
            }))
            sys.exit(1)

        # Multiply matrices
        result = multiply_matrices(matrix_a, matrix_b)

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
