import { z } from "zod";

/**
 * Worker tool-spec contract (Phase 2.5).
 *
 * Distilled from docs/reference/mythos-harness-reference.md: the lever that
 * raises agent completion rates is not the number of tools, it is that every
 * tool carries a tight, three-part contract: an explicit "when to use", an
 * explicit "when NOT to use", and a gating rule. This module formalizes that
 * contract for the worker-facing capabilities Magnesium grants (the
 * config.worker.allowedTools entries) and renders it into a compact prompt
 * section the worker system prompt can append.
 *
 * This is a guidance and rendering layer only. Hard enforcement still happens
 * at the claude CLI --allowedTools boundary: a tool absent from the allowlist
 * is rejected before the worker ever reads this guidance. The registry mirrors
 * that allowlist so the worker's mental model matches what it is actually
 * permitted to do; it is not a security boundary on its own.
 *
 * Pure and dependency-light: zod for boundary validation, nothing else.
 */

/**
 * The three-part tool contract for a single worker-facing capability.
 *
 * - name: the tool identifier as the worker sees it (matches an
 *   config.worker.allowedTools entry, e.g. "Read", "Bash(pnpm:*)", or a
 *   capability group label like "git").
 * - purpose: one line on what the tool is for.
 * - whenToUse: the affordance. Required, because a tool with no stated use is
 *   noise in the prompt.
 * - whenNotToUse: the negative affordance. Optional; present when there is a
 *   meaningful misuse to head off.
 * - gating: a short, non-prescriptive note on any access rule or block.
 *   Optional; present for forbidden or restricted capabilities. Kept minimal
 *   (e.g. "Blocked by Magnesium (orchestrator only)"), not a full system
 *   message, so the rendered guidance stays compact.
 */
export interface ToolSpec {
  name: string;
  purpose: string;
  whenToUse: string;
  whenNotToUse?: string;
  gating?: string;
}

/** A registry is just an ordered list of specs; order is the render order. */
export type ToolSpecRegistry = ToolSpec[];

/**
 * Zod schema enforcing the three-part contract at the boundary. Required
 * strings must be non-empty after trimming; optional strings, when present,
 * must also be non-empty (an empty whenNotToUse or gating is a mistake, not an
 * intentional absence: omit the field instead).
 */
const nonEmpty = z.string().trim().min(1);
export const ToolSpecSchema: z.ZodType<ToolSpec> = z.object({
  name: nonEmpty,
  purpose: nonEmpty,
  whenToUse: nonEmpty,
  whenNotToUse: nonEmpty.optional(),
  gating: nonEmpty.optional(),
});

/**
 * Default registry of worker-facing tool specs.
 *
 * Mirrors config.worker.allowedTools in src/config/defaults.ts: Read, Write,
 * Edit, and the Bash(...) command patterns are all granted, while git (push,
 * force-push, any remote op) is explicitly forbidden via gating. If the
 * allowlist changes, this list must be updated to match; there is no automated
 * link between the two (see the integration notes).
 *
 * The Bash entry deliberately enumerates the allowed patterns in whenToUse so
 * the worker sees exactly which command families are permitted, rather than a
 * vague "you may run shell commands".
 */
export const DEFAULT_TOOL_SPECS: ToolSpecRegistry = [
  {
    name: "Read",
    purpose: "Read a file, directory listing, or image from the worktree.",
    whenToUse:
      "Before editing or asserting the contents of any file. Read first, then act on what is actually there.",
    whenNotToUse:
      "Do not re-read a file you just wrote or edited only to confirm the change; the edit tools fail loudly when they do not apply.",
  },
  {
    name: "Write",
    purpose: "Create a new file or fully overwrite an existing one.",
    whenToUse:
      "When creating a new source or test file, or when replacing a file's entire contents is genuinely simpler than a targeted edit.",
    whenNotToUse:
      "Do not use Write for a small change to a large file; that risks dropping unrelated content. Prefer Edit for partial changes.",
  },
  {
    name: "Edit",
    purpose: "Replace a unique string in an existing file.",
    whenToUse:
      "For targeted changes to a file you have already read. The old string must match the file exactly and occur once.",
    whenNotToUse:
      "Do not use Edit to create a file (use Write) or when the target string is not unique; disambiguate or read more context first.",
  },
  {
    name: "Bash(pnpm:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Bash(ls:*), Bash(cat:*), Bash(grep:*), Bash(mkdir:*)",
    purpose:
      "Run a permitted shell command family inside the worktree (package scripts, the test runner, file inspection, directory creation).",
    whenToUse:
      "To install dependencies, run tests, inspect files, or create directories while implementing the task. Only these command families are allowed: pnpm, npm, npx, node, ls, cat, grep, mkdir.",
    whenNotToUse:
      "Do not attempt commands outside the allowed families (no curl, no rm -rf of the tree, no network tools); they are rejected before they run. Prefer the Read tool over cat for inspecting files you will edit.",
    gating:
      "Only the listed command patterns are permitted; anything else is blocked at the allowlist boundary.",
  },
  {
    name: "git",
    purpose: "Version-control operations (commit, push, branch, remote).",
    whenToUse:
      "Never. The worktree is managed for you; leave version control to the orchestrator.",
    whenNotToUse:
      "Never use git push, force-push, or any remote operation; this is orchestrator-only. Do not run git commands at all.",
    gating: "Blocked by Magnesium (orchestrator only).",
  },
];

/**
 * Validate a tool-spec registry. Throws a ZodError if any spec is missing a
 * required field or has an empty string where content is required, and throws
 * a plain Error if two specs share a name (a duplicate would render twice and
 * signals a copy-paste mistake). Returns the validated registry on success so
 * it can be used inline.
 */
export function validateToolSpecRegistry(specs: ToolSpecRegistry): ToolSpecRegistry {
  const validated = z.array(ToolSpecSchema).parse(specs);
  const seen = new Set<string>();
  for (const spec of validated) {
    if (seen.has(spec.name)) {
      throw new Error(`duplicate tool spec name: ${spec.name}`);
    }
    seen.add(spec.name);
  }
  return validated;
}

/**
 * Render a registry into a compact markdown section for the worker prompt.
 *
 * Returns the empty string for an empty registry so callers can append the
 * result unconditionally without producing a dangling heading. The output is
 * plain markdown with no em dashes (hyphens only) and contains no characters
 * that would break the surrounding prompt. Each spec renders as a bullet with
 * its name in bold followed by the purpose, then nested sub-bullets for
 * when-to-use, when-NOT (if present), and gating (if present).
 */
export function renderToolGuidance(specs: ToolSpecRegistry): string {
  if (specs.length === 0) return "";

  const lines: string[] = ["Tool Guidance:"];
  for (const spec of specs) {
    lines.push(`- ${spec.name}: ${spec.purpose}`);
    lines.push(`  - Use when: ${spec.whenToUse}`);
    if (spec.whenNotToUse !== undefined) {
      lines.push(`  - Do not use when: ${spec.whenNotToUse}`);
    }
    if (spec.gating !== undefined) {
      lines.push(`  - Gating: ${spec.gating}`);
    }
  }
  return lines.join("\n");
}
