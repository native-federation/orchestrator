const SUPPORTED_ALGORITHMS = {
  'sha256-': 'SHA-256',
  'sha384-': 'SHA-384',
  'sha512-': 'SHA-512',
} as const;

type Prefix = keyof typeof SUPPORTED_ALGORITHMS;

const parseIntegrity = (integrity: string): { algorithm: string; expected: string } | null => {
  for (const prefix of Object.keys(SUPPORTED_ALGORITHMS) as Prefix[]) {
    if (integrity.startsWith(prefix)) {
      return { algorithm: SUPPORTED_ALGORITHMS[prefix], expected: integrity };
    }
  }
  return null;
};

const toBase64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin);
};

export const verifyIntegrity = async (bytes: ArrayBuffer, integrity: string): Promise<void> => {
  const parsed = parseIntegrity(integrity);
  if (!parsed) {
    throw new TypeError(
      `Unsupported integrity prefix in '${integrity}'. Expected sha256-, sha384-, or sha512-.`
    );
  }

  const subtle =
    typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : undefined;
  if (!subtle) {
    throw new Error('SubtleCrypto is not available in this environment.');
  }

  const digest = await subtle.digest(parsed.algorithm, bytes);
  const actual =
    integrity.substring(0, integrity.indexOf('-') + 1) + toBase64(digest);

  if (actual !== parsed.expected) {
    throw new Error(`Integrity mismatch: expected ${parsed.expected}, got ${actual}`);
  }
};
