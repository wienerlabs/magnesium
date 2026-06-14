import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Deterministic, filesystem-safe slug derived from arbitrary text. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s.length > 0 ? s : "task";
}

export function nowIso(): string {
  return new Date().toISOString();
}
