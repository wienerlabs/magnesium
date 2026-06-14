export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BackoffOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  factor: number;
  jitter: boolean;
}

export const defaultBackoff: BackoffOptions = {
  retries: 5,
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: true,
};

/**
 * Runs fn with exponential backoff plus optional jitter. Retries only when
 * isRetryable(error) is true. Throws the last error once retries are exhausted.
 */
export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: BackoffOptions = defaultBackoff,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === opts.retries || !isRetryable(error)) {
        throw error;
      }
      const raw = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, attempt));
      const delay = opts.jitter ? raw * (0.5 + Math.random() * 0.5) : raw;
      await sleep(delay);
    }
  }
  throw lastError;
}
