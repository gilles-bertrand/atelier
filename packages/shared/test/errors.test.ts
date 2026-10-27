import { describe, expect, it } from 'vitest';
import { AtelierError, serializeError } from '../src/index.js';

describe('serializeError', () => {
  it('conserve le code des AtelierError', () => {
    const err = new AtelierError('llm/unreachable', 'down', { retryable: true });
    expect(serializeError(err)).toEqual({
      code: 'llm/unreachable',
      message: 'down',
      retryable: true,
    });
  });
  it('normalise les erreurs inconnues', () => {
    expect(serializeError(new Error('boom')).code).toBe('internal');
    expect(serializeError('x').message).toBe('x');
  });
});
