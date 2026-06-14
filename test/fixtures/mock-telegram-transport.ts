import type {
  TelegramCallback,
  TelegramCommand,
  TelegramMessage,
  TelegramTransport,
} from "../../src/supervisor/telegram/transport";

/**
 * In-memory TelegramTransport for tests. Records every outbound message and lets
 * a test inject inbound commands and callbacks synchronously. No grammy, no
 * network. Mirrors the StubModelClient / StubWorker fixture style.
 */
export class MockTelegramTransport implements TelegramTransport {
  /** Every message passed to sendMessage, in order. */
  public readonly sent: TelegramMessage[] = [];

  private commandHandler?: (command: TelegramCommand) => void | Promise<void>;
  private callbackHandler?: (callback: TelegramCallback) => void | Promise<void>;

  /** When set, the next sendMessage rejects with this error (then it clears). */
  public failNextSend?: Error;

  async sendMessage(message: TelegramMessage): Promise<void> {
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = undefined;
      throw err;
    }
    this.sent.push(message);
  }

  onCommand(handler: (command: TelegramCommand) => void | Promise<void>): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) this.commandHandler = undefined;
    };
  }

  onCallback(handler: (callback: TelegramCallback) => void | Promise<void>): () => void {
    this.callbackHandler = handler;
    return () => {
      if (this.callbackHandler === handler) this.callbackHandler = undefined;
    };
  }

  // Test drivers ------------------------------------------------------------

  /** Simulate an inbound slash command. Awaits the handler so tests can assert. */
  async emitCommand(
    name: string,
    args: string[] = [],
    chatId = "test-chat",
  ): Promise<void> {
    const text = `/${name}${args.length ? " " + args.join(" ") : ""}`;
    await this.commandHandler?.({ name, args, text, chatId });
  }

  /** Simulate a raw inbound command object (for edge-case text). */
  async emitRawCommand(command: TelegramCommand): Promise<void> {
    await this.commandHandler?.(command);
  }

  /** Simulate an inline-button press carrying opaque callback data. */
  async emitCallback(data: string, chatId = "test-chat"): Promise<void> {
    await this.callbackHandler?.({ data, chatId, callbackId: "cb-1" });
  }

  /** The most recent outbound message, or undefined if none sent. */
  lastMessage(): TelegramMessage | undefined {
    return this.sent.at(-1);
  }

  /** Concatenated text of every outbound message, for substring assertions. */
  allText(): string {
    return this.sent.map((m) => m.text).join("\n");
  }

  /** Whether a handler is currently registered (drift / leak check). */
  hasCommandHandler(): boolean {
    return this.commandHandler !== undefined;
  }

  hasCallbackHandler(): boolean {
    return this.callbackHandler !== undefined;
  }
}
