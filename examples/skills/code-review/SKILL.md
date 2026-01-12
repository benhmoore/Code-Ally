---
name: code-review
description: Systematic code review workflow. Use this when asked to review code, PRs, or assess code quality.
---

# Code Review Skill

Follow this systematic approach when reviewing code.

## Review Process

1. **Understand Context**
   - What is the purpose of this code?
   - What problem does it solve?
   - Read any related documentation or comments

2. **Check Correctness**
   - Does the code do what it claims?
   - Are edge cases handled?
   - Are there logic errors?

3. **Assess Code Quality**
   - Is the code readable and well-organized?
   - Are naming conventions followed?
   - Is there unnecessary complexity?
   - Are there code smells (duplication, long functions, deep nesting)?

4. **Review Security**
   - Input validation present?
   - Sensitive data handled properly?
   - No hardcoded secrets?
   - SQL injection / XSS / command injection vulnerabilities?

5. **Check Performance**
   - Obvious inefficiencies?
   - Appropriate data structures?
   - N+1 queries or unnecessary loops?

6. **Verify Testing**
   - Are there tests?
   - Do tests cover the changes?
   - Are edge cases tested?

## Output Format

Structure your review as:

```
## Summary
Brief overview of what the code does and overall assessment.

## Strengths
- What's done well

## Issues
### Critical (must fix)
- Security vulnerabilities, bugs

### Important (should fix)
- Code quality, performance issues

### Minor (consider)
- Style, suggestions

## Recommendations
Specific actionable improvements.
```

## Guidelines

- Be constructive, not critical
- Explain *why* something is an issue
- Provide specific suggestions, not vague complaints
- Acknowledge good work
- Prioritize issues by severity
