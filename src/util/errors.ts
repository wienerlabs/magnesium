export type ErrorCode =
  | "CONFIG"
  | "DAG_INVALID"
  | "BUDGET_EXCEEDED"
  | "WORKER"
  | "VERIFICATION"
  | "LEDGER"
  | "RUNTIME"
  | "CONFIRMATION_DENIED";

export class MagnesiumError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = "MagnesiumError";
    this.code = code;
  }
}

export class ConfigError extends MagnesiumError {
  constructor(message: string) {
    super(message, "CONFIG");
    this.name = "ConfigError";
  }
}

export class DagValidationError extends MagnesiumError {
  constructor(message: string) {
    super(message, "DAG_INVALID");
    this.name = "DagValidationError";
  }
}

export class BudgetExceededError extends MagnesiumError {
  constructor(message: string) {
    super(message, "BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
  }
}

export class WorkerError extends MagnesiumError {
  constructor(message: string) {
    super(message, "WORKER");
    this.name = "WorkerError";
  }
}

export class ConfirmationDeniedError extends MagnesiumError {
  constructor(message: string) {
    super(message, "CONFIRMATION_DENIED");
    this.name = "ConfirmationDeniedError";
  }
}
