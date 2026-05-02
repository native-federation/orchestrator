type TTCreateScript = (input: string) => string;
type TTCreateScriptURL = (input: string) => string;

type TTPolicyRules = {
  createScript?: TTCreateScript;
  createScriptURL?: TTCreateScriptURL;
};

type TTPolicy = {
  createScript: TTCreateScript;
  createScriptURL: TTCreateScriptURL;
};

type TTFactory = {
  createPolicy: (name: string, rules: TTPolicyRules) => TTPolicy;
};

export type NFTrustedTypesPolicy = {
  createScript: (input: string) => string;
  createScriptURL: (input: string) => string;
};

const IMPORT_MAP_KEYS = new Set(['imports', 'scopes', 'integrity']);

const validateImportMapJSON = (input: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new TypeError('[nf-orchestrator] trusted-types: import map is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('[nf-orchestrator] trusted-types: import map must be a plain object');
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!IMPORT_MAP_KEYS.has(key)) {
      throw new TypeError(`[nf-orchestrator] trusted-types: unexpected key "${key}" in import map`);
    }
  }
  return input;
};

const validateScriptURL = (input: string): string => {
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new TypeError(`[nf-orchestrator] trusted-types: invalid script URL "${input}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(
      `[nf-orchestrator] trusted-types: disallowed protocol "${url.protocol}" for script URL`
    );
  }
  return input;
};

const passThroughPolicy: NFTrustedTypesPolicy = {
  createScript: input => input,
  createScriptURL: input => input,
};

let cachedPolicy: NFTrustedTypesPolicy | null = null;

export const getTrustedTypesPolicy = (
  name: string | false = 'nfo'
): NFTrustedTypesPolicy => {
  if (name === false) return passThroughPolicy;
  if (cachedPolicy) return cachedPolicy;

  const factory = (globalThis as { trustedTypes?: TTFactory }).trustedTypes;
  if (!factory) {
    cachedPolicy = passThroughPolicy;
    return cachedPolicy;
  }

  const native = factory.createPolicy(name, {
    createScript: validateImportMapJSON,
    createScriptURL: validateScriptURL,
  });

  cachedPolicy = {
    createScript: input => native.createScript(input) as unknown as string,
    createScriptURL: input => native.createScriptURL(input) as unknown as string,
  };
  return cachedPolicy;
};

export const __resetTrustedTypesPolicyForTests = (): void => {
  cachedPolicy = null;
};
