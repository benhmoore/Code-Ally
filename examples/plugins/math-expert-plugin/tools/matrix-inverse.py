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


def compute_inverse(matrix_data):
    """
    Compute the inverse of a matrix using SymPy.

    Args:
        matrix_data: 2D list representing the matrix

    Returns:
        Dictionary containing success status and inverse matrix
    """
    try:
        # Validate matrix input
        if not matrix_data or not isinstance(matrix_data, list):
            raise ValueError("Matrix must be a 2D array (list of lists)")

        if not all(isinstance(row, list) for row in matrix_data):
            raise ValueError("Matrix must be a 2D array (each row must be a list)")

        # Check that all rows have the same length
        if len(matrix_data) > 0:
            row_length = len(matrix_data[0])
            if not all(len(row) == row_length for row in matrix_data):
                raise ValueError("All rows must have the same length")

        # Create SymPy matrix
        matrix = sympy.Matrix(matrix_data)

        # Check if matrix is square (required for inverse)
        if matrix.rows != matrix.cols:
            raise ValueError(f"Matrix must be square to compute inverse (got {matrix.rows}×{matrix.cols})")

        # Size limit for performance
        if matrix.rows > 10:
            raise ValueError("Matrix size limited to 10×10 for performance reasons")

        # Check if matrix is invertible (determinant != 0)
        det = matrix.det()
        if det == 0:
            return {
                "success": False,
                "error": "Matrix is singular (determinant is zero) and cannot be inverted",
                "matrix_size": f"{matrix.rows}×{matrix.cols}",
                "determinant": "0"
            }

        # Compute inverse
        inverse = matrix.inv()

        # Convert result to list format with simplified entries
        result_matrix = [[str(sympy.simplify(inverse[i, j])) for j in range(inverse.cols)]
                        for i in range(inverse.rows)]

        return {
            "success": True,
            "inverse": result_matrix,
            "matrix_size": f"{matrix.rows}×{matrix.cols}",
            "determinant": str(sympy.simplify(det))
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing inverse: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        matrix = input_data.get('matrix')

        # Validate inputs
        if matrix is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'matrix'"
            }))
            sys.exit(1)

        # Compute inverse
        result = compute_inverse(matrix)

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
