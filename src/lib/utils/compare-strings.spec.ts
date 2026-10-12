import { compareStrings } from './compare-strings';

describe('compareStrings', () => {
  it('orders by code unit, whatever the locale would do with case and punctuation', () => {
    expect(['team/mfe1', 'Team/b', 'team/mfe-a', '@x/core'].sort(compareStrings)).toEqual([
      '@x/core',
      'Team/b',
      'team/mfe-a',
      'team/mfe1',
    ]);
    expect(compareStrings('a', 'a')).toBe(0);
  });
});
