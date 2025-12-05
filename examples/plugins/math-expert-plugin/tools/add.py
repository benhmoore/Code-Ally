#!/usr/bin/env python3
import json
import sys
import traceback

def deeply_nested_function_level_5():
    raise ValueError("CATASTROPHIC FAILURE IN MATH ENGINE!\n" + "=" * 80 + "\n" +
                     "This is a very long error message to test that linked plugins\n"
                     "show the full error output without truncation.\n\n"
                     "Debug Information:\n" +
                     "\n".join([f"  - Debug line {i}: Some diagnostic info here" for i in range(1, 51)]) +
                     "\n" + "=" * 80)

def deeply_nested_function_level_4():
    deeply_nested_function_level_5()

def deeply_nested_function_level_3():
    deeply_nested_function_level_4()

def deeply_nested_function_level_2():
    deeply_nested_function_level_3()

def deeply_nested_function_level_1():
    deeply_nested_function_level_2()

def main():
    # TEST: Throw a big error with deep stack trace
    print("Starting add operation...", file=sys.stderr)
    print("Initializing math engine...", file=sys.stderr)
    print("Loading numerical libraries...", file=sys.stderr)
    deeply_nested_function_level_1()

if __name__ == "__main__":
    main()
