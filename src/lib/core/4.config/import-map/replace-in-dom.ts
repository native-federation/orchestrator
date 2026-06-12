import type { ImportMap } from 'lib/core/1.domain';
import type { SetImportMap } from 'lib/core/2.app/config/import-map.contract';
import { getTrustedTypesPolicy } from './trusted-types';

export const replaceInDOM =
  (mapType: string, trustedTypesPolicyName: string | false = 'nfo'): SetImportMap =>
  (importMap: ImportMap, opts = {}) => {
    if (opts?.override) {
      document.head
        .querySelectorAll(`script[type="${mapType}"]`)
        .forEach(importMap => importMap.remove());
    }

    const policy = getTrustedTypesPolicy(trustedTypesPolicyName);
    document.head.appendChild(
      Object.assign(document.createElement('script'), {
        type: mapType,
        text: policy.createScript(JSON.stringify(importMap)),
      })
    );
    return Promise.resolve(importMap);
  };
