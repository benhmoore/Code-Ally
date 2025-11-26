#!/usr/bin/env python3
import json
import sys

def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        a = input_data.get('a')
        b = input_data.get('b')

        if a is None or b is None:
            print(json.dumps({
                "success": False,
                "error": "Missing required parameters 'a' and 'b'"
            }))
            sys.exit(1)

        # Perform subtraction
        result = a - b

        # Return result
        print(json.dumps({
            "success": True,
            "result": result,
            "operation": f"{a} - {b} = {result}"
        }))

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
