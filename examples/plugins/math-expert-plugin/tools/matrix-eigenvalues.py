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


def compute_eigenvalues(matrix_data, include_eigenvectors=False):
    """
    Compute eigenvalues (and optionally eigenvectors) of a matrix using SymPy.

    Args:
        matrix_data: 2D list representing the matrix
        include_eigenvectors: Whether to also compute eigenvectors

    Returns:
        Dictionary containing success status, eigenvalues, and optionally eigenvectors
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

        # Check if matrix is square (required for eigenvalues)
        if matrix.rows != matrix.cols:
            raise ValueError(f"Matrix must be square to compute eigenvalues (got {matrix.rows}×{matrix.cols})")

        # Size limit for performance
        if matrix.rows > 10:
            raise ValueError("Matrix size limited to 10×10 for performance reasons")

        if include_eigenvectors:
            # Compute eigenvalues and eigenvectors
            # eigenvects() returns list of tuples: (eigenvalue, multiplicity, [eigenvectors])
            eigenvects = matrix.eigenvects()

            eigenvalues_list = []
            eigenvectors_list = []

            for eigenval, multiplicity, eigenvecs in eigenvects:
                eigenvalues_list.append({
                    "value": str(sympy.simplify(eigenval)),
                    "multiplicity": multiplicity
                })

                # Convert eigenvectors to list format
                for eigenvec in eigenvecs:
                    vector = [str(sympy.simplify(eigenvec[i])) for i in range(eigenvec.rows)]
                    eigenvectors_list.append({
                        "eigenvalue": str(sympy.simplify(eigenval)),
                        "vector": vector
                    })

            return {
                "success": True,
                "eigenvalues": eigenvalues_list,
                "eigenvectors": eigenvectors_list,
                "matrix_size": f"{matrix.rows}×{matrix.cols}"
            }
        else:
            # Compute only eigenvalues
            # eigenvals() returns dict: {eigenvalue: multiplicity}
            eigenvals_dict = matrix.eigenvals()

            eigenvalues_list = []
            for eigenval, multiplicity in eigenvals_dict.items():
                eigenvalues_list.append({
                    "value": str(sympy.simplify(eigenval)),
                    "multiplicity": multiplicity
                })

            return {
                "success": True,
                "eigenvalues": eigenvalues_list,
                "matrix_size": f"{matrix.rows}×{matrix.cols}"
            }

    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error computing eigenvalues: {str(e)}"
        }


def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        matrix = input_data.get('matrix')
        include_eigenvectors = input_data.get('include_eigenvectors', False)

        # Validate inputs
        if matrix is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameter 'matrix'"
            }))
            sys.exit(1)

        if not isinstance(include_eigenvectors, bool):
            print(json.dumps({
                "success": False,
                "error": "include_eigenvectors must be a boolean"
            }))
            sys.exit(1)

        # Compute eigenvalues (and eigenvectors if requested)
        result = compute_eigenvalues(matrix, include_eigenvectors)

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
