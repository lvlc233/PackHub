/**
 * PAL 的错误语义：每个失败都有一个稳定的 code，界面与 CLI 靠它给动作，
 * 不靠翻文案猜。HTTP 状态也在这里定，避免未知实例回 500 这类事。
 */
export type PalErrorCode =
  | 'invalid-input'
  | 'unknown-instance'
  | 'unknown-harness'
  | 'name-taken'
  | 'root-occupied'
  | 'not-startable'
  | 'harness-missing'
  | 'start-failed'
  | 'already-running'
  | 'not-running'
  | 'port-in-use'
  | 'busy'
  | 'install-failed'
  | 'record-corrupt'
  | 'not-found'
  | 'forbidden'
  | 'internal';

const STATUS: Record<PalErrorCode, number> = {
  'invalid-input': 400,
  'unknown-instance': 404,
  'unknown-harness': 400,
  'name-taken': 409,
  'root-occupied': 409,
  'not-startable': 422,
  'harness-missing': 422,
  'start-failed': 500,
  'already-running': 409,
  'not-running': 409,
  'port-in-use': 409,
  busy: 409,
  'install-failed': 422,
  'record-corrupt': 409,
  'not-found': 404,
  forbidden: 403,
  internal: 500,
};

export interface PalErrorOptions {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class PalError extends Error {
  readonly code: PalErrorCode;
  readonly status: number;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: PalErrorCode, message: string, options: PalErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PalError';
    this.code = code;
    this.status = STATUS[code];
    if (options.hint) this.hint = options.hint;
    if (options.details) this.details = options.details;
  }
}

export function isPalError(err: unknown): err is PalError {
  return err instanceof PalError;
}

/** 给 HTTP 层用：统一把错误变成可读的 JSON。 */
export function errorBody(err: unknown): {
  error: string;
  code: string;
  status: number;
  hint?: string;
  details?: Record<string, unknown>;
} {
  if (isPalError(err)) {
    return {
      error: err.message,
      code: err.code,
      status: err.status,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.details ? { details: err.details } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: message, code: 'internal', status: 500 };
}

export function statusOfError(err: unknown): number {
  return isPalError(err) ? err.status : 500;
}
