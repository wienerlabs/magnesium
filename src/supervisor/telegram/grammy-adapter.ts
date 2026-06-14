// ISOLATION BOUNDARY: this is the ONLY file in the telegram module that imports
// grammy. The core surface, confirmation gate, and all tests depend solely on
// the TelegramTransport interface, so they build and run with no grammy present.
// This file only type-checks / runs once `grammy` is added to dependencies.
import { Bot, InlineKeyboard } from "grammy";

import type { Logger } from "../../logging/logger";
import {
  parseCommand,
  TelegramCallbackSchema,
  TelegramCommandSchema,
  type TelegramCallback,
  type TelegramCommand,
  type TelegramMessage,
  type TelegramTransport,
} from "./transport";

export interface GrammyTransportOptions {
  /** Telegram Bot API token. Source from env or secrets, never hardcode. */
  token: string;
  /**
   * Chat id this transport is bound to. Outbound messages go here; inbound
   * commands and callbacks from other chats are dropped at the boundary.
   */
  chatId: string | number;
  logger: Logger;
}

type CommandHandler = (command: TelegramCommand) => void | Promise<void>;
type CallbackHandler = (callback: TelegramCallback) => void | Promise<void>;

/**
 * grammY-backed TelegramTransport. Translates grammY contexts into the plain
 * TelegramTransport contract and back. Long-polls via bot.start(); call stop()
 * on shutdown. Single-chat binding: updates from any other chat are ignored so a
 * stray group cannot drive the supervisor.
 */
export class GrammyTransport implements TelegramTransport {
  private readonly bot: Bot;
  private readonly chatId: string;
  private readonly logger: Logger;
  private commandHandler?: CommandHandler;
  private callbackHandler?: CallbackHandler;
  private started = false;

  constructor(opts: GrammyTransportOptions) {
    this.bot = new Bot(opts.token);
    this.chatId = String(opts.chatId);
    this.logger = opts.logger;
    this.wire();
  }

  async sendMessage(message: TelegramMessage): Promise<void> {
    const reply_markup =
      message.buttons && message.buttons.length > 0
        ? this.buildKeyboard(message.buttons)
        : undefined;
    await this.bot.api.sendMessage(this.chatId, message.text, { reply_markup });
  }

  onCommand(handler: CommandHandler): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) this.commandHandler = undefined;
    };
  }

  onCallback(handler: CallbackHandler): () => void {
    this.callbackHandler = handler;
    return () => {
      if (this.callbackHandler === handler) this.callbackHandler = undefined;
    };
  }

  /** Begin long polling. Resolves once polling has started. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // bot.start() resolves only when the bot stops, so do not await it here.
    void this.bot.start({
      onStart: () => this.logger.info("grammy transport polling started"),
    });
  }

  /** Stop long polling gracefully. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.bot.stop();
  }

  private buildKeyboard(buttons: TelegramMessage["buttons"]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const b of buttons ?? []) {
      kb.text(b.text, b.data);
    }
    return kb;
  }

  private wire(): void {
    // All text messages: parse slash-commands at the boundary, validate, route.
    this.bot.on("message:text", async (ctx) => {
      if (String(ctx.chat.id) !== this.chatId) return;
      const parsed = parseCommand(ctx.message.text, String(ctx.chat.id));
      if (!parsed) return;
      const result = TelegramCommandSchema.safeParse(parsed);
      if (!result.success) {
        this.logger.warn({ issues: result.error.issues }, "rejected malformed command");
        return;
      }
      await this.commandHandler?.(result.data);
    });

    // Inline-button presses. Always answer the query so the client stops its
    // loading spinner, then route the validated payload.
    this.bot.on("callback_query:data", async (ctx) => {
      const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      if (chatId !== undefined && String(chatId) !== this.chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const candidate: TelegramCallback = {
        data: ctx.callbackQuery.data,
        chatId: String(chatId ?? this.chatId),
        callbackId: ctx.callbackQuery.id,
      };
      const result = TelegramCallbackSchema.safeParse(candidate);
      await ctx.answerCallbackQuery();
      if (!result.success) {
        this.logger.warn({ issues: result.error.issues }, "rejected malformed callback");
        return;
      }
      await this.callbackHandler?.(result.data);
    });

    this.bot.catch((err) => {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "grammy bot error",
      );
    });
  }
}

/** Convenience factory mirroring the rest of the codebase's create* helpers. */
export function createGrammyTransport(opts: GrammyTransportOptions): GrammyTransport {
  return new GrammyTransport(opts);
}
