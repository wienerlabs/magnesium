import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

/**
 * Structured JSON logger. Secrets are redacted defensively so an API key can
 * never reach the log stream, the ledger, or a worktree.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.MAGNESIUM_LOG_LEVEL ?? "info";
  const pretty = opts.pretty ?? process.env.MAGNESIUM_LOG_PRETTY === "1";

  const redact = {
    paths: [
      "apiKey",
      "ANTHROPIC_API_KEY",
      "env.ANTHROPIC_API_KEY",
      "*.ANTHROPIC_API_KEY",
      "headers.authorization",
      "*.authorization",
    ],
    censor: "[redacted]",
  };

  if (pretty) {
    return pino({
      level,
      redact,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
    });
  }

  return pino({ level, redact });
}
