import { z } from "zod";

import type { EventRow } from "../ledger/types";

/**
 * Format EventRow entries as a structured event stream: one line per event,
 * for tailing and diagnostics. Pure functions over ledger rows, no I/O.
 */

export interface EventStreamLine {
  seq: number;
  timestamp: string;
  type: string;
  taskId: string | null;
  /** The event payload encoded as a single-line JSON string. */
  payload: string;
}

export const EventStreamFormatSchema = z.enum(["plain", "json"]);
export type EventStreamFormat = z.infer<typeof EventStreamFormatSchema>;

function toLine(event: EventRow): EventStreamLine {
  return {
    seq: event.seq,
    timestamp: event.createdAt,
    type: event.type,
    taskId: event.taskId,
    payload: JSON.stringify(event.payload),
  };
}

function renderPlain(line: EventStreamLine): string {
  const task = line.taskId === null ? "" : `  task=${line.taskId}`;
  return `#${line.seq}  ${line.timestamp}  ${line.type}${task}  ${line.payload}`;
}

/**
 * Convert an EventRow array into a newline-joined string. "plain" yields a
 * compact human-readable line per event; "json" yields one JSON-encoded
 * EventStreamLine per event (JSON Lines). An empty input yields "".
 *
 * The format argument is validated with zod; an unknown value throws rather
 * than silently defaulting, so the CLI can surface a clear error.
 */
export function formatEvents(events: EventRow[], format: EventStreamFormat): string {
  const mode = EventStreamFormatSchema.parse(format);
  const lines = events.map(toLine);
  if (mode === "json") {
    return lines.map((l) => JSON.stringify(l)).join("\n");
  }
  return lines.map(renderPlain).join("\n");
}
