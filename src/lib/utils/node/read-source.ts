import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NFError } from 'lib/native-federation.error';

const isHttpUrl = (input: string): boolean =>
  input.startsWith('http://') || input.startsWith('https://');

const isFileUrl = (input: string): boolean => input.startsWith('file://');

export const readSourceBytes = async (input: string): Promise<ArrayBuffer> => {
  if (isHttpUrl(input)) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new NFError(`${response.status} - ${response.statusText}`);
    }
    return response.arrayBuffer();
  }

  const path = isFileUrl(input) ? fileURLToPath(input) : input;
  const buffer = await fs.readFile(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
