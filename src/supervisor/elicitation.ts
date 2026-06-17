import { z } from "zod";

import type { Logger } from "../logging/logger";
import { uuid } from "../util/ids";
import type { TelegramCallback, TelegramTransport } from "./telegram/transport";

/**
 * Phase 2.5: structured elicitation gate (the ask_user_input primitive).
 *
 * Mirrors the Mythos `ask_user_input_v0` action: instead of asking the user a
 * prose question, the orchestrator or a worker emits a typed, schema-validated
 * request whose options render as tappable inline buttons. The turn ends; the
 * gate resolves when the matching callback arrives.
 *
 * This module keeps the contract transport-agnostic (ElicitationGate) and ships
 * one Telegram-backed implementation (TelegramElicitationGate). The Telegram
 * gate depends ONLY on the existing TelegramTransport interface (sendMessage +
 * onCallback), never on grammy, so the whole thing is exercised offline with a
 * mock transport. It reuses the same pending-map + timeout + idempotent-settle
 * pattern as src/supervisor/telegram/confirmation.ts.
 *
 * Transport contract (no transport edits needed): the request renders as a
 * single-row inline keyboard via TelegramMessage.buttons; presses arrive as
 * TelegramCallback.data strings that the gate parses to settle a pending entry.
 */

/** Five minutes. After this a pending elicitation auto-denies (empty answer). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Telegram inline-button text limit. Labels longer than this render badly. */
const MAX_LABEL_LEN = 60;

/** Option keys must stay free of the ':' and ',' used as payload separators. */
const OPTION_KEY_RE = /^[A-Za-z0-9_-]+$/;

export const ELICITATION_TYPES = [
  "single_select",
  "multi_select",
  "rank_priorities",
] as const;

export type ElicitationType = (typeof ELICITATION_TYPES)[number];

/**
 * One selectable option. `key` is the stable identifier carried in callback
 * payloads and returned in responses; `label` is the human-visible button text.
 * Keys are alphanumeric + dash/underscore so they never collide with the ':'
 * and ',' payload separators.
 */
export const ElicitationOptionSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(OPTION_KEY_RE, "option key must be alphanumeric, dash, or underscore"),
  label: z.string().min(1).max(MAX_LABEL_LEN),
});

export type ElicitationOption = z.infer<typeof ElicitationOptionSchema>;

/**
 * A single question with 2-4 options. `type` defaults to single_select. Option
 * keys must be unique within a question so a callback maps to exactly one option.
 */
export const ElicitationQuestionSchema = z
  .object({
    question: z.string().min(1),
    options: z.array(ElicitationOptionSchema).min(2).max(4),
    type: z.enum(ELICITATION_TYPES).default("single_select"),
  })
  .superRefine((q, ctx) => {
    const keys = new Set<string>();
    for (const opt of q.options) {
      if (keys.has(opt.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate option key: ${opt.key}`,
          path: ["options"],
        });
      }
      keys.add(opt.key);
    }
  });

/** A question after schema defaults are applied (type is always present). */
export type ElicitationQuestion = z.infer<typeof ElicitationQuestionSchema>;

/** A question as authored, before defaults (type optional). */
export type ElicitationQuestionInput = z.input<typeof ElicitationQuestionSchema>;

/**
 * A structured elicitation request: 1-3 questions gathered in one turn-ending
 * gate. Matches the Mythos ask_user_input_v0 shape (one question ideal, three max).
 */
export const ElicitationRequestSchema = z.object({
  questions: z.array(ElicitationQuestionSchema).min(1).max(3),
});

export type ElicitationRequest = z.infer<typeof ElicitationRequestSchema>;
export type ElicitationRequestInput = z.input<typeof ElicitationRequestSchema>;

/**
 * The answer to a single question. The shape depends on the question type:
 *  - single_select  -> one option key (string)
 *  - multi_select   -> zero or more option keys (string[])
 *  - rank_priorities -> all option keys in the user's chosen order (string[])
 * `answered` is false when the gate denied the question (timeout or close).
 */
export interface ElicitationAnswer {
  type: ElicitationType;
  /** single_select selection, or null when not a single_select / unanswered. */
  selected: string | null;
  /** multi_select / rank_priorities selection, or [] otherwise. */
  selectedMany: string[];
  /** False when the gate denied (timeout, close) rather than the user answering. */
  answered: boolean;
}

/** The full response: one answer per question, in request order. */
export interface ElicitationResponse {
  answers: ElicitationAnswer[];
  /** False when any question was denied (timeout or gate close). */
  answered: boolean;
}

/**
 * Transport-agnostic contract for gathering structured user input. A turn-ending
 * gate: elicit() resolves once the user has answered every question, the timeout
 * fires, or the gate is closed.
 */
export interface ElicitationGate {
  elicit(request: ElicitationRequestInput): Promise<ElicitationResponse>;
}

// ---------------------------------------------------------------------------
// Response-payload parsing (the spec's parseElicitationResponse surface).
//
// A settled answer can be serialized to / parsed from a compact payload so it
// can round-trip through a single callback string when a richer multi-step UI is
// not desired:
//   single_select   -> "select:<key>"
//   multi_select    -> "multi:<key1>,<key2>"        (zero or more; "multi:" = none)
//   rank_priorities -> "rank:<key1>:<key2>:..."     (all keys, in order)
// ---------------------------------------------------------------------------

export interface ParsedElicitationResponse {
  type: ElicitationType;
  keys: string[];
}

/**
 * Parse a settled-answer payload into its type and ordered keys. Returns null on
 * a malformed payload (wrong prefix, missing colon, empty key). A "multi:" with
 * no keys is valid (an empty multi_select); a "select:" / "rank:" with no key is not.
 */
export function parseElicitationResponse(data: string): ParsedElicitationResponse | null {
  const idx = data.indexOf(":");
  if (idx <= 0) return null;
  const prefix = data.slice(0, idx);
  const rest = data.slice(idx + 1);

  if (prefix === "select") {
    if (!isValidKey(rest)) return null;
    return { type: "single_select", keys: [rest] };
  }

  if (prefix === "multi") {
    if (rest.length === 0) return { type: "multi_select", keys: [] };
    const keys = rest.split(",");
    if (!keys.every(isValidKey)) return null;
    return { type: "multi_select", keys };
  }

  if (prefix === "rank") {
    if (rest.length === 0) return null;
    const keys = rest.split(":");
    if (!keys.every(isValidKey)) return null;
    return { type: "rank_priorities", keys };
  }

  return null;
}

function isValidKey(key: string): boolean {
  return key.length > 0 && OPTION_KEY_RE.test(key);
}

// ---------------------------------------------------------------------------
// Per-button callback parsing (internal interactive protocol).
//
// Each request gets a unique id; every button carries the request id so a press
// settles exactly the right pending entry. Encoding (':' separated, request id
// is a uuid with no ':' and keys are key-safe):
//   single_select toggle/commit -> "esel:<reqId>:<qIndex>:<key>"   (commits immediately)
//   multi_select toggle         -> "emul:<reqId>:<qIndex>:<key>"   (toggles, no commit)
//   multi_select commit         -> "emuldone:<reqId>:<qIndex>"
//   rank_priorities pick        -> "erank:<reqId>:<qIndex>:<key>"  (appends to order)
//   rank_priorities commit      -> "erankdone:<reqId>:<qIndex>"
//   skip / cancel question      -> "eskip:<reqId>:<qIndex>"
// ---------------------------------------------------------------------------

type CallbackKind = "esel" | "emul" | "emuldone" | "erank" | "erankdone" | "eskip";

interface ParsedCallback {
  kind: CallbackKind;
  requestId: string;
  questionIndex: number;
  key?: string;
}

const CALLBACK_KINDS: ReadonlySet<string> = new Set([
  "esel",
  "emul",
  "emuldone",
  "erank",
  "erankdone",
  "eskip",
]);

function isCallbackKind(value: string): value is CallbackKind {
  return CALLBACK_KINDS.has(value);
}

/**
 * Parse an interactive button payload. Returns null on any malformed shape so a
 * garbage callback can never crash the handler. Exported for white-box tests.
 */
export function parseElicitationCallback(data: string): ParsedCallback | null {
  const parts = data.split(":");
  const [kind, requestId, qIndexRaw, key] = parts;
  if (!kind || !isCallbackKind(kind)) return null;
  if (!requestId || requestId.length === 0) return null;
  if (qIndexRaw === undefined) return null;
  const questionIndex = Number(qIndexRaw);
  if (!Number.isInteger(questionIndex) || questionIndex < 0) return null;

  const needsKey = kind === "esel" || kind === "emul" || kind === "erank";
  if (needsKey) {
    if (key === undefined || !isValidKey(key) || parts.length !== 4) return null;
    return { kind, requestId, questionIndex, key };
  }
  // emuldone / erankdone / eskip carry no key.
  if (parts.length !== 3) return null;
  return { kind, requestId, questionIndex };
}

export interface TelegramElicitationGateOptions {
  transport: TelegramTransport;
  logger: Logger;
  /** Override the pending-request timeout. Defaults to five minutes. */
  timeoutMs?: number;
}

/** A single in-flight question awaiting user input. */
interface PendingQuestion {
  question: ElicitationQuestion;
  /** Working selection for multi_select / rank_priorities. */
  picks: string[];
  resolve: (answer: ElicitationAnswer) => void;
}

/** A whole in-flight elicit() call, one PendingQuestion per question. */
interface PendingRequest {
  questions: PendingQuestion[];
  /** Index of the question currently being asked. */
  cursor: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: ElicitationResponse) => void;
}

/**
 * Telegram-backed ElicitationGate. elicit() validates the request, then walks the
 * questions one at a time: it posts the current question with one inline button
 * per option (plus a confirm button for multi_select / rank_priorities) and
 * resolves when the user has answered every question, the timeout fires (deny),
 * or close() is called (deny).
 *
 * Concurrent elicit() calls are tracked independently by request id. No grammy
 * import: every interaction is mediated by the injected transport, so the whole
 * gate is testable offline with a mock transport.
 */
export class TelegramElicitationGate implements ElicitationGate {
  private readonly transport: TelegramTransport;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(opts: TelegramElicitationGateOptions) {
    this.transport = opts.transport;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.unsubscribe = this.transport.onCallback((cb) => this.handleCallback(cb));
  }

  async elicit(request: ElicitationRequestInput): Promise<ElicitationResponse> {
    // Validate at the boundary; defaults (type=single_select) are applied here.
    const parsed = ElicitationRequestSchema.parse(request);

    if (this.closed) return deniedResponse(parsed.questions);

    const id = uuid();

    // Build the pending entry and per-question resolvers BEFORE sending so a fast
    // callback can never race a missing entry (same guard as the confirm gate).
    const answers: (ElicitationAnswer | undefined)[] = new Array(parsed.questions.length);
    const result = new Promise<ElicitationResponse>((resolveResponse) => {
      const questions: PendingQuestion[] = parsed.questions.map((question, i) => ({
        question,
        picks: [],
        resolve: (answer) => {
          answers[i] = answer;
        },
      }));

      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.logger.warn({ requestId: id }, "elicitation timed out: denying");
          resolveResponse(deniedResponse(parsed.questions));
        }
      }, this.timeoutMs);
      // Do not keep the event loop alive solely for a pending elicitation.
      timer.unref?.();

      this.pending.set(id, {
        questions,
        cursor: 0,
        timer,
        resolve: () => {
          // All questions answered: stitch the per-question answers in order.
          const finished = answers.map(
            (a, i) => a ?? deniedAnswer(parsed.questions[i]!.type),
          );
          resolveResponse({
            answers: finished,
            answered: finished.every((a) => a.answered),
          });
        },
      });
    });

    try {
      await this.sendQuestion(id, 0);
    } catch (err) {
      // Tear the entry down and let the send error bubble to the caller.
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
      }
      throw err;
    }

    return result;
  }

  /** Reject all outstanding elicitations (deny) and stop listening. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const id of [...this.pending.keys()]) {
      this.deny(id);
    }
  }

  /** Render question `qIndex` of request `id` as an inline-button message. */
  private async sendQuestion(id: string, qIndex: number): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    const pq = entry.questions[qIndex];
    if (!pq) return;
    const { question, picks } = pq;

    const header =
      entry.questions.length > 1
        ? `Question ${qIndex + 1} of ${entry.questions.length}: ${question.question}`
        : question.question;
    const hint = typeHint(question.type, picks);

    const buttons = this.buildButtons(id, qIndex, question, picks);

    await this.transport.sendMessage({
      text: [header, "", hint].join("\n"),
      buttons,
    });
  }

  /** Defensive secondary validation: build one button per option, plus controls. */
  private buildButtons(
    id: string,
    qIndex: number,
    question: ElicitationQuestion,
    picks: string[],
  ): { text: string; data: string }[] {
    const buttons: { text: string; data: string }[] = [];
    for (const opt of question.options) {
      // Re-check the key invariant so a malformed request can never emit a button
      // whose callback would fail to parse.
      if (!isValidKey(opt.key)) {
        throw new Error(`invalid option key in elicitation: ${opt.key}`);
      }
      const label = decorateLabel(question.type, opt, picks);
      buttons.push({ text: label, data: this.buttonData(id, qIndex, question.type, opt.key) });
    }
    if (question.type === "multi_select") {
      buttons.push({ text: "Confirm", data: `emuldone:${id}:${qIndex}` });
    } else if (question.type === "rank_priorities") {
      buttons.push({ text: "Confirm order", data: `erankdone:${id}:${qIndex}` });
    }
    return buttons;
  }

  private buttonData(id: string, qIndex: number, type: ElicitationType, key: string): string {
    switch (type) {
      case "single_select":
        return `esel:${id}:${qIndex}:${key}`;
      case "multi_select":
        return `emul:${id}:${qIndex}:${key}`;
      case "rank_priorities":
        return `erank:${id}:${qIndex}:${key}`;
    }
  }

  private handleCallback(cb: TelegramCallback): void {
    const parsed = parseElicitationCallback(cb.data);
    if (!parsed) return;
    const entry = this.pending.get(parsed.requestId);
    // Unknown / already-settled request ids are safely ignored (idempotent).
    if (!entry) {
      this.logger.debug({ data: cb.data }, "elicitation callback for unknown request ignored");
      return;
    }
    // Ignore callbacks for a question that is not the one currently being asked;
    // this prevents stale buttons from an earlier step settling the wrong answer.
    if (parsed.questionIndex !== entry.cursor) {
      this.logger.debug(
        { requestId: parsed.requestId, got: parsed.questionIndex, want: entry.cursor },
        "elicitation callback for non-active question ignored",
      );
      return;
    }
    const pq = entry.questions[entry.cursor];
    if (!pq) return;

    switch (parsed.kind) {
      case "esel":
        this.completeQuestion(parsed.requestId, {
          type: "single_select",
          selected: parsed.key!,
          selectedMany: [],
          answered: true,
        });
        break;
      case "emul":
        toggle(pq.picks, parsed.key!);
        void this.rerender(parsed.requestId, entry.cursor);
        break;
      case "emuldone":
        this.completeQuestion(parsed.requestId, {
          type: "multi_select",
          selected: null,
          selectedMany: [...pq.picks],
          answered: true,
        });
        break;
      case "erank":
        // Append on first pick, no-op if already ranked (idempotent tap).
        if (!pq.picks.includes(parsed.key!)) pq.picks.push(parsed.key!);
        void this.rerender(parsed.requestId, entry.cursor);
        break;
      case "erankdone":
        this.completeQuestion(parsed.requestId, {
          type: "rank_priorities",
          selected: null,
          // Any options the user did not explicitly rank keep their original order.
          selectedMany: completeRanking(pq.question, pq.picks),
          answered: true,
        });
        break;
      case "eskip":
        this.completeQuestion(parsed.requestId, deniedAnswer(pq.question.type));
        break;
    }
  }

  /** Re-post the current question to reflect an updated working selection. */
  private async rerender(id: string, qIndex: number): Promise<void> {
    try {
      await this.sendQuestion(id, qIndex);
    } catch (err) {
      // A re-render send failure should not crash the gate; the pending entry and
      // its timeout remain intact so the user (or the timeout) can still settle it.
      this.logger.warn({ requestId: id, err }, "elicitation re-render failed");
    }
  }

  /** Record an answer for the active question; advance or finish the request. */
  private completeQuestion(id: string, answer: ElicitationAnswer): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    const pq = entry.questions[entry.cursor];
    if (!pq) return;
    pq.resolve(answer);
    entry.cursor += 1;

    if (entry.cursor >= entry.questions.length) {
      this.settle(id);
      return;
    }
    // Ask the next question. A send failure here cannot reject the caller's
    // promise (it already returned), so deny the remaining questions on failure.
    void this.sendQuestion(id, entry.cursor).catch((err) => {
      this.logger.warn({ requestId: id, err }, "failed to send next elicitation question");
      this.deny(id);
    });
  }

  /** Resolve the request promise with the stitched answers, then clean up. */
  private settle(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(emptyResponse());
  }

  /** Deny a request: resolve every still-pending question as unanswered. */
  private deny(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    for (let i = entry.cursor; i < entry.questions.length; i++) {
      entry.questions[i]!.resolve(deniedAnswer(entry.questions[i]!.question.type));
    }
    entry.resolve(emptyResponse());
  }
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

function toggle(arr: string[], value: string): void {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(value);
}

/** Append any unranked option keys (in original order) after the user's picks. */
function completeRanking(question: ElicitationQuestion, picks: string[]): string[] {
  const ranked = [...picks];
  for (const opt of question.options) {
    if (!ranked.includes(opt.key)) ranked.push(opt.key);
  }
  return ranked;
}

function decorateLabel(type: ElicitationType, opt: ElicitationOption, picks: string[]): string {
  if (type === "multi_select") {
    return picks.includes(opt.key) ? `[x] ${opt.label}` : `[ ] ${opt.label}`;
  }
  if (type === "rank_priorities") {
    const rank = picks.indexOf(opt.key);
    return rank >= 0 ? `${rank + 1}. ${opt.label}` : opt.label;
  }
  return opt.label;
}

function typeHint(type: ElicitationType, picks: string[]): string {
  switch (type) {
    case "single_select":
      return "Tap one option.";
    case "multi_select":
      return `Tap to toggle options, then Confirm. Selected: ${picks.length}.`;
    case "rank_priorities":
      return "Tap options in priority order, then Confirm order.";
  }
}

function deniedAnswer(type: ElicitationType): ElicitationAnswer {
  return { type, selected: null, selectedMany: [], answered: false };
}

function deniedResponse(questions: ElicitationQuestion[]): ElicitationResponse {
  return {
    answers: questions.map((q) => deniedAnswer(q.type)),
    answered: false,
  };
}

/** Placeholder resolved value; the real answers are stitched by the closure. */
function emptyResponse(): ElicitationResponse {
  return { answers: [], answered: false };
}
