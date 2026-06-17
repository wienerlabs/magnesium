# Skill: coding

Applies to code tasks: implementing features, fixing bugs, adding functionality
inside the worktree.

## Read before acting

- Read the existing code and tests in the worktree before changing anything.
  Match the surrounding style, naming, and module conventions.
- Confirm a tool or library is already available before importing it. Do not add
  new dependencies unless the task asks for them.

## Test-driven workflow

- Write the tests alongside the implementation. A code task is not done until its
  tests exist and pass.
- Prefer the smallest change that satisfies every acceptance criterion. Do not
  gold-plate, refactor unrelated code, or add speculative abstractions.

## Hard constraints

- Do not run git. Do not commit, push, branch, or force-push. Integration is the
  orchestrator's job, not the worker's.
- Do not modify files outside the worktree directory.
- Keep changes minimal and focused on the task. Remove any scratch or debug code
  before finishing.

## Finish discipline

- Re-read your diff before declaring done. Verify each acceptance criterion is
  met by a concrete change or test, not by assertion.
