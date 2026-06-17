import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderSkillGuidance,
  selectSkills,
  SkillRegistry,
  type SkillSelectionTask,
  type SkillSpec,
} from "../../src/workers/skill-registry";
import type { WorkerTask } from "../../src/workers/worker";

/** Build a WorkerTask-shaped object for selection tests. */
function task(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    runId: "run123456",
    taskId: "task78901234",
    slug: "slugify",
    title: "Build slugify",
    description: "implement it",
    acceptanceCriteria: ["tests pass"],
    kind: "code",
    model: "claude-sonnet-4-6",
    worktreePath: "/abs/worktrees/run/task",
    ...over,
  };
}

/** A registry seeded with the built-in playbooks. */
const seeded = SkillRegistry.seeded();

describe("SkillRegistry construction", () => {
  it("fromSpecs returns a registry with all specs indexed and queryable", () => {
    const specs: SkillSpec[] = [
      { name: "alpha", description: "a", appliesTo: () => true, body: "## alpha\nbody a" },
      { name: "beta", description: "b", appliesTo: () => false, body: "## beta\nbody b" },
    ];
    const reg = SkillRegistry.fromSpecs(specs);
    expect(reg.list().map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(reg.get("alpha")?.body).toContain("body a");
    expect(reg.get("missing")).toBeUndefined();
  });

  it("seeded registry exposes the four built-in playbooks", () => {
    expect(seeded.list().map((s) => s.name)).toEqual([
      "coding",
      "research",
      "generic",
      "refactoring",
    ]);
  });

  it("is immutable after construction (list returns a copy, frozen internally)", () => {
    const reg = SkillRegistry.seeded();
    const first = reg.list();
    first.push({ name: "x", description: "x", appliesTo: () => true, body: "x" });
    // Mutating the returned array must not affect the registry.
    expect(reg.list()).toHaveLength(4);
  });
});

describe("selectSkills kind-based selection", () => {
  it("returns the coding spec for a code task", () => {
    const names = selectSkills(task({ kind: "code" }), seeded).map((s) => s.name);
    expect(names).toContain("coding");
  });

  it("returns the research spec for a research task", () => {
    const names = selectSkills(
      task({ kind: "research", title: "survey the market", acceptanceCriteria: ["cite sources"] }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("research");
    expect(names).not.toContain("coding");
  });

  it("returns the generic spec for a generic task", () => {
    const names = selectSkills(
      task({ kind: "generic", title: "draft a summary", acceptanceCriteria: ["one page"] }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("generic");
    expect(names).not.toContain("coding");
    expect(names).not.toContain("research");
  });

  it("ignores non-matching specs (research spec does not apply to a code task)", () => {
    const names = selectSkills(task({ kind: "code" }), seeded).map((s) => s.name);
    expect(names).not.toContain("research");
    expect(names).not.toContain("generic");
  });

  it("uses the seeded registry when none is supplied", () => {
    const names = selectSkills(task({ kind: "research", title: "research x" })).map((s) => s.name);
    expect(names).toContain("research");
  });
});

describe("selectSkills compound predicates (refactoring)", () => {
  it("applies both kind-based and appliesTo predicates: refactoring is a code task with refactor markers", () => {
    const names = selectSkills(
      task({
        kind: "code",
        title: "Refactor the parser",
        description: "simplify and deduplicate the token logic",
        acceptanceCriteria: ["behavior unchanged", "remove dead code"],
      }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("coding");
    expect(names).toContain("refactoring");
  });

  it("does not select refactoring for an ordinary feature code task", () => {
    const names = selectSkills(
      task({
        kind: "code",
        title: "Add CSV export",
        description: "implement a new export endpoint",
        acceptanceCriteria: ["downloads a csv"],
      }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("coding");
    expect(names).not.toContain("refactoring");
  });

  it("does not select refactoring for a non-code task even with refactor wording", () => {
    const names = selectSkills(
      task({
        kind: "research",
        title: "Research how teams simplify their cleanup processes",
        acceptanceCriteria: ["cite sources"],
      }),
      seeded,
    ).map((s) => s.name);
    expect(names).not.toContain("refactoring");
    expect(names).toContain("research");
  });

  it("matches refactor markers in acceptanceCriteria as well as title and description", () => {
    const names = selectSkills(
      task({
        kind: "code",
        title: "Tidy module",
        description: "general cleanup",
        acceptanceCriteria: ["rename the helper to camelCase"],
      }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("refactoring");
  });

  it("selects kind-based specs even when acceptanceCriteria is empty", () => {
    const names = selectSkills(
      task({ kind: "code", acceptanceCriteria: [] }),
      seeded,
    ).map((s) => s.name);
    expect(names).toContain("coding");
  });

  it("respects a priorFailure hint without throwing (selection still runs)", () => {
    const selected = selectSkills(
      task({ kind: "code", priorFailure: "the test suite failed: 2 tests red" }),
      seeded,
    );
    expect(selected.map((s) => s.name)).toContain("coding");
  });
});

describe("renderSkillGuidance", () => {
  it("returns an empty string when no specs are selected", () => {
    expect(renderSkillGuidance([])).toBe("");
  });

  it("formats a single spec with the header and the body verbatim", () => {
    const spec: SkillSpec = {
      name: "demo",
      description: "demo",
      appliesTo: () => true,
      body: "## demo\n- rule one\n- rule two",
    };
    const out = renderSkillGuidance([spec]);
    expect(out).toContain("Skills (read the relevant playbook before acting):");
    expect(out).toContain("## demo");
    expect(out).toContain("- rule one");
    expect(out).toContain("- rule two");
  });

  it("renders each spec body without mutation", () => {
    const original = "## keep\n  indented line\nplain line";
    const spec: SkillSpec = {
      name: "keep",
      description: "keep",
      appliesTo: () => true,
      body: original,
    };
    const out = renderSkillGuidance([spec]);
    // The exact body text survives, including its internal indentation.
    expect(out).toContain("  indented line");
    expect(out).toContain("plain line");
  });

  it("separates multiple specs with a divider", () => {
    const specs: SkillSpec[] = [
      { name: "one", description: "one", appliesTo: () => true, body: "## one\nbody one" },
      { name: "two", description: "two", appliesTo: () => true, body: "## two\nbody two" },
    ];
    const out = renderSkillGuidance(specs);
    expect(out).toContain("## one");
    expect(out).toContain("## two");
    expect(out).toContain("\n---\n");
    // Divider appears exactly once for two specs.
    expect(out.split("\n---\n")).toHaveLength(2);
  });

  it("skips specs whose body is empty or whitespace only", () => {
    const specs: SkillSpec[] = [
      { name: "full", description: "full", appliesTo: () => true, body: "## full\nbody" },
      { name: "blank", description: "blank", appliesTo: () => true, body: "   \n  " },
    ];
    const out = renderSkillGuidance(specs);
    expect(out).toContain("## full");
    expect(out).not.toContain("blank");
    // Only one real spec, so no divider.
    expect(out).not.toContain("\n---\n");
  });

  it("is deterministic for the same spec list", () => {
    const specs = seeded.select(task({ kind: "code" }));
    const a = renderSkillGuidance(specs);
    const b = renderSkillGuidance(specs);
    expect(a).toBe(b);
  });

  it("renders the seeded coding playbook with the no-git rule for a code task", () => {
    const out = renderSkillGuidance(selectSkills(task({ kind: "code" }), seeded));
    expect(out).toContain("Do not run git");
    expect(out).toContain("smallest change");
  });
});

describe("SkillRegistry malformed-spec handling", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("drops a spec with an empty body and warns", () => {
    const specs: SkillSpec[] = [
      { name: "good", description: "good", appliesTo: () => true, body: "## good\nbody" },
      { name: "empty", description: "empty", appliesTo: () => true, body: "" },
    ];
    const reg = SkillRegistry.fromSpecs(specs);
    expect(reg.list().map((s) => s.name)).toEqual(["good"]);
    expect(warn).toHaveBeenCalled();
  });

  it("drops a spec missing required data fields and warns", () => {
    const bad = {
      name: "",
      description: "",
      appliesTo: () => true,
      body: "## bad",
    } as SkillSpec;
    const reg = SkillRegistry.fromSpecs([bad]);
    expect(reg.list()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("an empty-body spec never reaches a rendered prompt", () => {
    const reg = SkillRegistry.fromSpecs([
      { name: "empty", description: "empty", appliesTo: () => true, body: "  " },
    ]);
    const out = renderSkillGuidance(reg.select(task()));
    expect(out).toBe("");
  });
});

describe("SkillSelectionTask compatibility", () => {
  it("accepts a minimal SkillSelectionTask shape", () => {
    const minimal: SkillSelectionTask = {
      kind: "generic",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
    };
    expect(selectSkills(minimal, seeded).map((s) => s.name)).toContain("generic");
  });
});
