#!/usr/bin/env python3
import json
import sys

def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)

        reason = input_data.get('reason', 'Operation not supported with available tools')

        # Return result indicating the agent cannot perform the calculation
        print(json.dumps({
            "success": True,
            "result": f"I cannot perform this calculation with my available tools. {reason}",
            "cannot_calculate": True
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
