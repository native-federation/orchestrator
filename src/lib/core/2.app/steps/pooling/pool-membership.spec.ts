import { resolvePoolMembership } from './pool-membership';
import { createMockLogHandler } from 'lib/testing/handlers/log.handler';

describe('resolvePoolMembership', () => {
  describe('remote-declared pool tag (precedence 1)', () => {
    it('returns the declared tag', () => {
      expect(resolvePoolMembership('@angular/core', ['angular'], false)).toBe('angular');
    });

    it('wins over auto-derivation', () => {
      expect(resolvePoolMembership('@angular/core', ['ng'], true)).toBe('ng');
    });

    it('applies to unscoped packages too', () => {
      expect(resolvePoolMembership('rxjs', ['reactive'], false)).toBe('reactive');
    });

    it('ignores empty / whitespace-only tags', () => {
      expect(resolvePoolMembership('@angular/core', ['', '   '], false)).toBeUndefined();
    });

    it('dedupes identical tags without warning', () => {
      const log = createMockLogHandler('debug');
      expect(resolvePoolMembership('@angular/core', ['angular', 'angular'], false, log)).toBe(
        'angular'
      );
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns on conflicting tags and picks the first sorted (stable)', () => {
      const log = createMockLogHandler('debug');
      expect(resolvePoolMembership('@angular/core', ['ng', 'angular'], false, log)).toBe('angular');
      expect(log.warn).toHaveBeenCalledOnce();
    });
  });

  describe('auto npm-scope derivation (precedence 2)', () => {
    it('derives the scope for scoped packages when enabled', () => {
      expect(resolvePoolMembership('@angular/common', [], true)).toBe('angular');
    });

    it('does not auto-pool unscoped packages', () => {
      expect(resolvePoolMembership('rxjs', [], true)).toBeUndefined();
    });

    it('does nothing when auto-pooling is disabled', () => {
      expect(resolvePoolMembership('@angular/core', [], false)).toBeUndefined();
    });
  });
});
