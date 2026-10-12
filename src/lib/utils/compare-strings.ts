// Code-unit order: unlike `localeCompare`, the same in every browser and locale, so anything stored or elected
// from a name comes out identical everywhere.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { compareStrings };
