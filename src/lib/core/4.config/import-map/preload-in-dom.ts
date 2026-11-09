import type { PreloadModules } from 'lib/core/2.app/config/import-map.contract';

// No crossorigin or integrity: the attributes must match the import's own request, and the import map's
// integrity already applies to a link without one. Only document.head, the one place es-module-shims watches.
export const preloadInDOM = (rel: 'modulepreload' | 'modulepreload-shim'): PreloadModules => {
  // A module is loaded again on every visit to its route; without this the head grows a link per visit.
  const preloaded = new Set<string>();
  return urls => {
    for (const href of urls) {
      if (preloaded.has(href)) continue;
      preloaded.add(href);
      document.head.appendChild(Object.assign(document.createElement('link'), { rel, href }));
    }
  };
};
