# Skill: refactoring

Applies to code tasks whose intent is restructuring rather than new behavior.
Triggers on acceptance criteria or titles mentioning refactor, simplify,
cleanup, clean up, restructure, deduplicate, dead code, or rename.

## Preserve behavior

- A refactor must not change observable behavior. The existing tests are your
  contract: run them before and after, and they must still pass unchanged.
- If a test must change to express the new structure, that is a signal the
  refactor altered behavior. Stop and re-check the task scope.

## Simplify systematically

- Make one structural change at a time: extract, rename, inline, or move. Do not
  bundle a behavior change into the same pass.
- Remove dead code, unused imports, and unreachable branches you uncover. Leave
  the module smaller than you found it where you can.

## Keep the diff legible

- Prefer mechanical, reviewable edits over a sweeping rewrite. A reviewer should
  be able to confirm equivalence by reading the diff.
- Do not introduce new dependencies or abstractions that the task did not ask
  for. Simpler, not cleverer.

## Hard constraints

- Do not run git. Do not modify files outside the worktree. Keep the change
  scoped to the refactor described in the task.
