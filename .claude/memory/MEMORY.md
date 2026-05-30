<!-- Claude Code auto memory index. Managed by Claude; do not edit manually. -->

- [Do not invoke update-config when entering plan mode](feedback_plan_mode.md) — invoking update-config before EnterPlanMode is a mistake; use EnterPlanMode directly
- [Bun migration and release plan](project_bun_migration.md) — issue 107 Node→Bun migration; cut a new release after merge
- [Validate curl URLs before committing](feedback_curl_url_validation.md) — new curl-installable deps must have URL verified reachable before commit; catches 404s locally instead of in CI
- [Cut releases by pushing the tag](feedback_release_cutting.md) — use `git tag && git push origin <tag>`; do not use `gh release create` (publishes immediately and traps the workflow's asset upload)
- [Use --body-file for multiline gh comments](feedback_gh_multiline_comments.md) — always write complex/multiline comment bodies to a temp file and use --body-file; inline --body breaks on backticks and special chars