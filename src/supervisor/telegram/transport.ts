import { z } from "zod";

/**
 * Transport abstraction for the Telegram control surface. The core surface and
 * confirmation gate depend ONLY on this interface, never on grammy. A concrete
 * grammY adapter lives in grammy-adapter.ts; tests inject a mock. This keeps the
 * control logic fully offline-testable and the third-party dependency isolated.
 */

/** A chat command, e.g. "/status abcd1234" parsed into name + args. */
export interface TelegramCommand {
  /** Command name without the leading slash, lowercased (e.g. "status"). */
  name: string;
  /** Whitespace-split arguments after the command name. */
  args: string[];
  /** Raw text of the message as received. */
  text: string;
  /** Originating chat id, as a string for transport-neutrality. */
  chatId: string;
}

/** An inline-keyboard button press carrying an opaque callback payload. */
export interface TelegramCallback {
  /** Opaque payload encoded into the button (e.g. "approve:<actionId>"). */
  data: string;
  /** Chat the callback originated from. */
  chatId: string;
  /** Telegram callback query id, used by the adapter to answer the query. */
  callbackId?: string;
}

/** An inline-keyboard button: visible label plus opaque callback data. */
export interface TelegramButton {
  text: string;
  data: string;
}

/** An outbound message. Buttons render as a single-row inline keyboard. */
export interface TelegramMessage {
  text: string;
  /** Optional inline-keyboard buttons, one row. */
  buttons?: TelegramButton[];
}

/**
 * Minimal transport surface. The adapter is responsible for delivery; the core
 * never sees a grammy Context. onCommand/onCallback register a single handler
 * each (last registration wins) and return an unsubscribe function.
 */
export interface TelegramTransport {
  /** Send a message to the bound chat. Resolves once Telegram accepts it. */
  sendMessage(message: TelegramMessage): Promise<void>;
  /** Register the slash-command handler. Returns an unsubscribe fn. */
  onCommand(handler: (command: TelegramCommand) => void | Promise<void>): () => void;
  /** Register the inline-button callback handler. Returns an unsubscribe fn. */
  onCallback(handler: (callback: TelegramCallback) => void | Promise<void>): () => void;
}

/**
 * Boundary schemas. The adapter funnels untrusted Telegram payloads through
 * these before they reach the core, so a malformed update can never crash a
 * handler with an unexpected shape.
 */
export const TelegramCommandSchema: z.ZodType<TelegramCommand> = z.object({
  name: z.string().min(1),
  args: z.array(z.string()),
  text: z.string(),
  chatId: z.string().min(1),
});

export const TelegramCallbackSchema: z.ZodType<TelegramCallback> = z.object({
  data: z.string().min(1),
  chatId: z.string().min(1),
  callbackId: z.string().optional(),
});

/** Parse free-form message text into a command, or null if it is not one. */
export function parseCommand(text: string, chatId: string): TelegramCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const head = parts[0] ?? "";
  // Telegram addresses commands to a bot as "/cmd@BotName"; strip the suffix.
  const name = head.split("@")[0]?.toLowerCase() ?? "";
  if (name.length === 0) return null;
  return { name, args: parts.slice(1), text: trimmed, chatId };
}
