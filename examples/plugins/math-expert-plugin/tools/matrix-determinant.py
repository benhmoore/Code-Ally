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


def compute_determinant(matrix_data):
    """
    Compute the determinant of a matrix using SymPy.

    Args:
        matrix_data: 2D list representing the matrix

    Returns:
        Dictionary containing success status and determinant
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

        # Check if matrix is square (required for determinant)
        if matrix.rows != matrix.cols:
            raise ValueError(f"Matrix must be square to compute determinant (got {matrix.rows}×{matrix.cols})")

        # Size limit for performance
        if matrix.rows > 10:
            raise ValueError("Matrix size limited to 10×10 for performance reasons")

        # Compute determinant
        det = matrix.det()

        # Simplify the result
        simplified_det = sympy.simplify(det)

        return {
            "success": True,
            "determinant": str(simplified_det),
            "matrix_size": f"{matrix.rows}×{matrix.cols}",
            "is_singular": det == 0
        }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing determinant: {str(e)}"
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

        # Compute determinant
        result = compute_determinant(matrix)

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
