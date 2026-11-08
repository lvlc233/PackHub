import { describe, expect, it } from 'vitest';
import { errorBody, PalError, statusOfError } from '../src/errors.ts';

describe('PAL 错误状态映射', () => {
  it('start-failed 与 record-corrupt 是 422，不是 500/409', () => {
    const start = new PalError('start-failed', '起不来');
    const corrupt = new PalError('record-corrupt', '记录坏了');

    expect(start.status).toBe(422);
    expect(corrupt.status).toBe(422);
    expect(statusOfError(start)).toBe(422);
    expect(statusOfError(corrupt)).toBe(422);
    expect(errorBody(corrupt).status).toBe(422);
    expect(errorBody(corrupt).code).toBe('record-corrupt');
  });

  it('非 PalError 仍是 500', () => {
    expect(statusOfError(new Error('boom'))).toBe(500);
    expect(errorBody('boom').status).toBe(500);
  });
});
