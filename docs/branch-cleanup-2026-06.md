# opencode-plugins branch cleanup — recovery manifest (2026-06-08)

Deleted during supervisor extraction cleanup. To restore any branch:
`git push origin <sha>:refs/heads/<branch>`

## Deleted — merged into main (zero loss, also in main history)
- eval/expand-coverage                                104335a
- issue-120-reflection-toast                          8fefc01
- issue-123-reflection-next-steps                     b0f062e
- issue-74-plan-mode-reflection                       7422543
- issue-80-reflection-loop-prevention                 85d7a44

## Deleted — harvested into dzianisv/agents-supervisor (value preserved there)
- feat/supervisor-mode                                2c7b165   # goal loop → agents-supervisor core/goal.mjs + both runtimes
- fix/115-reflection-stuck-research-misclassification ee13878   # folded into core/patterns.json (analysis_no_implementation, stuck guidance)

## Deleted — local redundant copies (identical to remote, kept on remote)
- (local) issue-135-auto-review                       4fe631d
- (local) issue-136-package-auto-review               9aa93b9

## KEPT — unique unmerged work, not harvested
- feat/cross-model-review                             b4a5718   # cross-model consensus verdict (not ported)
- fix/opencode-worktree-sanitize-branch-name          1afc6b3   # worktree plugin fix (unrelated to supervisor)
- issue-135-auto-review                               4fe631d   # auto-review CI work
- issue-136-package-auto-review                       9aa93b9   # auto-review packaging (broader than the antipattern bit folded in)
