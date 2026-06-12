import {
  __resetTrustedTypesPolicyForTests,
  getTrustedTypesPolicy,
} from './trusted-types';

describe('getTrustedTypesPolicy', () => {
  afterEach(() => {
    delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
    __resetTrustedTypesPolicyForTests();
  });

  describe('when globalThis.trustedTypes is unavailable', () => {
    it('returns a transparent pass-through for createScript', () => {
      const policy = getTrustedTypesPolicy();
      expect(policy.createScript('{"imports":{}}')).toBe('{"imports":{}}');
    });

    it('returns a transparent pass-through for createScriptURL', () => {
      const policy = getTrustedTypesPolicy();
      expect(policy.createScriptURL('https://example.test/a.js')).toBe(
        'https://example.test/a.js'
      );
    });

    it('does not validate input when no native factory exists', () => {
      const policy = getTrustedTypesPolicy();
      // would otherwise be rejected by the policy validator
      expect(policy.createScript('not json')).toBe('not json');
      expect(policy.createScriptURL('javascript:alert(1)')).toBe('javascript:alert(1)');
    });
  });

  describe('when policy name is false', () => {
    it('returns the pass-through policy even if a native factory exists', () => {
      const createPolicy = jest.fn();
      (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };

      const policy = getTrustedTypesPolicy(false);
      expect(policy.createScript('whatever')).toBe('whatever');
      expect(createPolicy).not.toHaveBeenCalled();
    });
  });

  describe('when globalThis.trustedTypes is available', () => {
    let createPolicy: jest.Mock;

    beforeEach(() => {
      createPolicy = jest.fn((_name: string, rules: Record<string, unknown>) => ({
        createScript: rules['createScript'],
        createScriptURL: rules['createScriptURL'],
      }));
      (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };
    });

    it('creates the native policy with the provided name and validators', () => {
      getTrustedTypesPolicy('my-policy');
      expect(createPolicy).toHaveBeenCalledTimes(1);
      const [name, rules] = createPolicy.mock.calls[0]!;
      expect(name).toBe('my-policy');
      expect(typeof rules.createScript).toBe('function');
      expect(typeof rules.createScriptURL).toBe('function');
    });

    it('memoizes the policy across calls', () => {
      const a = getTrustedTypesPolicy('nfo');
      const b = getTrustedTypesPolicy('nfo');
      expect(createPolicy).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });
  });

  describe('createScript validator', () => {
    let validator: (input: string) => string;

    beforeEach(() => {
      const createPolicy = jest.fn((_name: string, rules: Record<string, unknown>) => {
        validator = rules['createScript'] as (input: string) => string;
        return {
          createScript: validator,
          createScriptURL: rules['createScriptURL'],
        };
      });
      (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };
      getTrustedTypesPolicy();
    });

    it('accepts a valid import map', () => {
      const json = JSON.stringify({
        imports: { foo: 'https://x.test/foo.js' },
        scopes: { 'https://x.test/': { bar: 'https://x.test/bar.js' } },
      });
      expect(validator(json)).toBe(json);
    });

    it('rejects malformed JSON', () => {
      expect(() => validator('{ not json')).toThrow(TypeError);
    });

    it('rejects non-object roots', () => {
      expect(() => validator(JSON.stringify(['imports']))).toThrow(TypeError);
      expect(() => validator(JSON.stringify('hello'))).toThrow(TypeError);
      expect(() => validator(JSON.stringify(null))).toThrow(TypeError);
    });

    it('rejects unexpected keys', () => {
      expect(() =>
        validator(JSON.stringify({ imports: {}, malicious: 'payload' }))
      ).toThrow(/unexpected key "malicious"/);
    });
  });

  describe('createScriptURL validator', () => {
    let validator: (input: string) => string;

    beforeEach(() => {
      const createPolicy = jest.fn((_name: string, rules: Record<string, unknown>) => {
        validator = rules['createScriptURL'] as (input: string) => string;
        return {
          createScript: rules['createScript'],
          createScriptURL: validator,
        };
      });
      (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };
      getTrustedTypesPolicy();
    });

    it('accepts http and https URLs', () => {
      expect(validator('https://example.test/a.js')).toBe('https://example.test/a.js');
      expect(validator('http://example.test/a.js')).toBe('http://example.test/a.js');
    });

    it('accepts relative URLs (resolved against the current document)', () => {
      expect(validator('/a.js')).toBe('/a.js');
    });

    it('rejects javascript: URLs', () => {
      expect(() => validator('javascript:alert(1)')).toThrow(/disallowed protocol/);
    });

    it('rejects data: URLs', () => {
      expect(() => validator('data:text/javascript,alert(1)')).toThrow(/disallowed protocol/);
    });

    it('rejects malformed URLs', () => {
      expect(() => validator('http://[bad')).toThrow(TypeError);
    });
  });
});
