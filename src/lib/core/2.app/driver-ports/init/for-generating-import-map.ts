import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type ForGeneratingImportMap = () => Promise<ImportMap>;
