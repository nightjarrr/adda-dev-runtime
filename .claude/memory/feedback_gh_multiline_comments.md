---
name: Use --body-file for multiline gh comments
description: For complex or multiline gh issue/PR comments, always write to a temp file and use --body-file, never inline --body
type: feedback
originSessionId: a3dc8f87-0bb2-48b5-adc5-c671433bd9f9
---
For complex, multi-line `gh issue comment` or `gh pr comment` calls, always write the body to a temp file first and reference it with `--body-file <path>` instead of passing the text inline via `--body`.

**Why:** Inline `--body` with multiline markdown (backticks, code blocks, special characters) gets interpreted by bash and causes failures — backtick commands execute, pipes are misread, etc.

**How to apply:** Any time a comment body contains markdown formatting, code blocks, backticks, or is more than one or two lines, write it with the Write tool to `/tmp/<descriptive-name>.md` then run `gh issue comment <id> --body-file /tmp/<descriptive-name>.md`.
