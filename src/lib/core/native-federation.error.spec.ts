import { NFError } from './native-federation.error';

describe('NFError', () => {
  it('keeps the error it wraps as its cause', () => {
    const inner = new Error('inner');

    const error = new NFError('x', inner);

    expect(error.cause).toBe(inner);
    expect(error.message).toBe('x');
    expect(error.name).toBe('NFError');
  });

  it('has no cause property when it wraps nothing', () => {
    expect('cause' in new NFError('x')).toBe(false);
  });
});
