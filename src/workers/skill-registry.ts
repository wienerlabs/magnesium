import { z } from "zod";

import type { TaskKind } from "../ledger/types";

/**
 * Skills-first worker playbooks (Phase 2.5).
 *
 * A worker consults the relevant playbook before acting. Each SkillSpec carries
 * a body (a SKILL.md-style playbook) plus an `appliesTo` predicate that decides
 * whether the skill is relevant to a given task. The registry holds the specs,
 * `selectSkills` returns the applicable ones for a task, and
 * `renderSkillGuidance` formats them into a block for the worker prompt.
 *
 * The seeded specs mirror the playbooks under `skills/<name>/SKILL.md`. They are
 * defined inline here (rather than read from disk) so selection and rendering are
 * fully synchronous and testable offline, with no file I/O on the hot path. The
 * SKILL.md files remain the human-readable source of truth; keep the two in sync.
 *
 * This operationalizes the Mythos-class "read the relevant SKILL.md before
 * producing any file or running code" pattern distilled in
 * docs/reference/mythos-harness-reference.md, section 3.
 */

/** The subset of task fields skill selection reads. WorkerTask satisfies this. */
export interface SkillSelectionTask {
  kind: TaskKind;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Failure report from a previous attempt, if this is a retry. */
  priorFailure?: string;
}

/**
 * A single playbook. `appliesTo` is the gating predicate (the "when to use"
 * contract from the harness reference); `body` is the markdown guidance injected
 * into the worker prompt verbatim.
 */
export interface SkillSpec {
  /** Stable identifier, also the `skills/<name>/SKILL.md` directory name. */
  name: string;
  /** One-line summary of what the playbook covers. */
  description: string;
  /** Returns true when this skill is relevant to the task. */
  appliesTo: (task: SkillSelectionTask) => boolean;
  /** The SKILL.md body, mirrored from skills/<name>/SKILL.md. */
  body: string;
}

/** Validates the data-bearing fields of a spec at registry construction time. */
const SkillSpecDataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string(),
});

/** Joins lines into a single body string. */
function body(...lines: string[]): string {
  return lines.join("\n");
}

/** Lowercased haystack of the task's matchable text for substring predicates. */
function taskText(task: SkillSelectionTask): string {
  return [task.title, task.description, ...task.acceptanceCriteria].join(" ").toLowerCase();
}

/**
 * Substring markers that signal a refactoring task. Kept narrow and specific so
 * `selectSkills` does not over-match ordinary feature work.
 */
const REFACTOR_MARKERS = [
  "refactor",
  "simplify",
  "cleanup",
  "clean up",
  "restructure",
  "deduplicate",
  "dead code",
  "rename",
];

/** True when the task text contains any refactoring marker. */
function looksLikeRefactor(task: SkillSelectionTask): boolean {
  const text = taskText(task);
  return REFACTOR_MARKERS.some((marker) => text.includes(marker));
}

/**
 * The seeded playbooks. Bodies mirror skills/<name>/SKILL.md. Each `appliesTo`
 * is the gating contract for that skill.
 */
const SEED_SPECS: readonly SkillSpec[] = [
  {
    name: "coding",
    description: "Test-driven, minimal-change discipline for code tasks; never run git.",
    appliesTo: (task) => task.kind === "code",
    body: body(
      "## coding",
      "",
      "- Read the existing code and tests before changing anything; match the",
      "  surrounding style, naming, and module conventions.",
      "- Confirm a library is already available before importing it; do not add new",
      "  dependencies unless the task asks for them.",
      "- Write the tests alongside the implementation. A code task is not done until",
      "  its tests exist and pass.",
      "- Prefer the smallest change that satisfies every acceptance criterion. Do not",
      "  gold-plate or refactor unrelated code.",
      "- Do not run git. Do not commit, push, branch, or force-push. Integration is",
      "  the orchestrator's job.",
      "- Do not modify files outside the worktree directory.",
      "- Re-read your diff before declaring done; verify each acceptance criterion is",
      "  met by a concrete change or test.",
    ),
  },
  {
    name: "research",
    description: "Verify sources, cite claims, scale search to complexity, decline unfounded synthesis.",
    appliesTo: (task) => task.kind === "research",
    body: body(
      "## research",
      "",
      "- Treat an unfamiliar capitalized name as probably outside training data:",
      "  search for it, do not confabulate. The same holds for current-status",
      "  questions even when they seem stable.",
      "- Cite every load-bearing claim to a concrete source. A synthesis with no",
      "  sources is a draft, not a result.",
      "- Scale search depth to complexity: one lookup for a single fact, three to",
      "  five for a medium question, more for a broad survey. Stop when sources",
      "  converge.",
      "- If the sources do not support a conclusion, say so plainly. Do not fill gaps",
      "  with confident guesses or invented numbers.",
      "- Separate what the sources say from your own inference, and label which is",
      "  which.",
      "- Copyright limits: quote under fifteen words per source, one quote per",
      "  source, default to paraphrase. Never reproduce lyrics, poems, or full",
      "  article paragraphs, and never mirror a source's structure.",
    ),
  },
  {
    name: "generic",
    description: "Structured elicitation, even-handed presentation, prose-first formatting, copyright limits.",
    appliesTo: (task) => task.kind === "generic",
    body: body(
      "## generic",
      "",
      "- If the task is genuinely ambiguous, surface the smallest structured",
      "  question that unblocks you, then proceed. Do not stall on a question you can",
      "  answer from the acceptance criteria.",
      "- Read every acceptance criterion as a checklist; the deliverable is done only",
      "  when each one is met.",
      "- On contested topics, present the strongest case its defenders would make,",
      "  framed as theirs, then the opposing perspectives. Decline only very extreme",
      "  positions, and avoid a forced yes or no.",
      "- Prose by default. Use lists only when the content is genuinely",
      "  multifaceted; keep formatting minimal.",
      "- Copyright limits: quote under fifteen words per source, one quote per",
      "  source, default to paraphrase. Never reproduce lyrics, poems, or full",
      "  article paragraphs, and never mirror a source's structure.",
    ),
  },
  {
    name: "refactoring",
    description: "Preserve behavior, no dead code, systematic and reviewable simplification.",
    appliesTo: (task) => task.kind === "code" && looksLikeRefactor(task),
    body: body(
      "## refactoring",
      "",
      "- A refactor must not change observable behavior. The existing tests are your",
      "  contract: run them before and after, and they must still pass unchanged.",
      "- If a test must change to express the new structure, that is a signal the",
      "  refactor altered behavior. Stop and re-check the task scope.",
      "- Make one structural change at a time: extract, rename, inline, or move. Do",
      "  not bundle a behavior change into the same pass.",
      "- Remove dead code, unused imports, and unreachable branches you uncover.",
      "- Prefer mechanical, reviewable edits over a sweeping rewrite. A reviewer",
      "  should be able to confirm equivalence by reading the diff.",
      "- Do not introduce new dependencies or abstractions the task did not ask for.",
    ),
  },
];

/**
 * An immutable collection of skill playbooks. Construct via `SkillRegistry.seeded()`
 * for the built-in specs, or `SkillRegistry.fromSpecs(specs)` for a custom set
 * (used by tests). Specs with an empty body are dropped at construction with a
 * warning, so they never reach a worker prompt.
 */
export class SkillRegistry {
  private readonly specs: readonly SkillSpec[];

  private constructor(specs: readonly SkillSpec[]) {
    this.specs = Object.freeze([...specs]);
  }

  /** Registry seeded with the built-in playbooks mirrored from skills/. */
  static seeded(): SkillRegistry {
    return SkillRegistry.fromSpecs(SEED_SPECS);
  }

  /**
   * Build a registry from an explicit spec list. Each spec's data fields are
   * validated; a spec with an empty or whitespace-only body is skipped (with a
   * console warning) so a malformed playbook cannot blank out the prompt.
   */
  static fromSpecs(specs: readonly SkillSpec[]): SkillRegistry {
    const kept: SkillSpec[] = [];
    for (const spec of specs) {
      const parsed = SkillSpecDataSchema.safeParse(spec);
      if (!parsed.success) {
        console.warn(`skill-registry: skipping invalid spec: ${parsed.error.message}`);
        continue;
      }
      if (spec.body.trim().length === 0) {
        console.warn(`skill-registry: skipping spec "${spec.name}" with empty body`);
        continue;
      }
      kept.push(spec);
    }
    return new SkillRegistry(kept);
  }

  /** All specs in the registry, in registration order. Returns a copy. */
  list(): SkillSpec[] {
    return [...this.specs];
  }

  /** Look up a spec by name, or undefined if absent. */
  get(name: string): SkillSpec | undefined {
    return this.specs.find((s) => s.name === name);
  }

  /** The specs whose `appliesTo` predicate matches the task, in registration order. */
  select(task: SkillSelectionTask): SkillSpec[] {
    return this.specs.filter((s) => s.appliesTo(task));
  }
}

/**
 * Select the skills applicable to a task. When a registry is not supplied, the
 * built-in seeded registry is used. Selection runs every spec's `appliesTo`
 * predicate, which combines kind-based gating (coding / research / generic) with
 * finer predicates (refactoring is a code task whose text signals restructuring).
 */
export function selectSkills(task: SkillSelectionTask, registry?: SkillRegistry): SkillSpec[] {
  const reg = registry ?? SkillRegistry.seeded();
  return reg.select(task);
}

/** Header that introduces the skills block in the worker prompt. */
const GUIDANCE_HEADER = "Skills (read the relevant playbook before acting):";

/** Divider between rendered specs. */
const GUIDANCE_DIVIDER = "---";

/**
 * Render the selected specs into a markdown block for the worker prompt. Each
 * spec's body is emitted verbatim (no mutation), multiple specs are separated by
 * a divider, and an empty selection yields an empty string so the caller can
 * append unconditionally. Output is deterministic for a given spec list.
 */
export function renderSkillGuidance(specs: readonly SkillSpec[]): string {
  const bodies = specs.map((s) => s.body.trim()).filter((b) => b.length > 0);
  if (bodies.length === 0) return "";
  return [GUIDANCE_HEADER, "", bodies.join(`\n\n${GUIDANCE_DIVIDER}\n\n`)].join("\n");
}
