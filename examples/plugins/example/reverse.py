#!/usr/bin/env python3
"""
Reverse String Plugin - Example Executable Plugin

This demonstrates how to create an executable plugin in any language.
The plugin receives JSON via stdin and outputs JSON via stdout.
"""

import json
import sys


def reverse_string(text: str, preserve_case: bool = True) -> dict:
    """
    Reverse a string, optionally preserving case.

    Args:
        text: The string to reverse
        preserve_case: Whether to preserve character casing

    Returns:
        Dictionary with success status and result
    """
    try:
        if preserve_case:
            # Simple reversal
            reversed_text = text[::-1]
        else:
            # Reverse and convert to lowercase
            reversed_text = text[::-1].lower()

        return {
            'success': True,
            'original': text,
            'reversed': reversed_text,
            'length': len(text),
            'preserved_case': preserve_case
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'Failed to reverse string: {str(e)}',
            'error_type': 'processing_error'
        }


def main():
    """Main entry point - reads JSON from stdin, outputs JSON to stdout."""
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())

        # Extract parameters
        text = input_data.get('text', '')
        preserve_case = input_data.get('preserve_case', True)

        # Validate input
        if not text:
            result = {
                'success': False,
                'error': 'Missing required parameter: text',
                'error_type': 'validation_error'
            }
        else:
            # Execute the operation
            result = reverse_string(text, preserve_case)

        # Output result as JSON
        print(json.dumps(result))

    except json.JSONDecodeError as e:
        # Invalid JSON input
        error_result = {
            'success': False,
            'error': f'Invalid JSON input: {str(e)}',
            'error_type': 'input_error'
        }
        print(json.dumps(error_result))
        sys.exit(1)

    except Exception as e:
        # Unexpected error
        error_result = {
            'success': False,
            'error': f'Unexpected error: {str(e)}',
            'error_type': 'system_error'
        }
        print(json.dumps(error_result))
        sys.exit(1)


if __name__ == '__main__':
    main()
