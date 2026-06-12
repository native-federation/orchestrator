type Imports = Record<string, string>;

type Scopes = Record<string, Imports>;

type Integrity = Record<string, string>;

type ImportMap = {
  imports: Imports;
  scopes?: Scopes;
  integrity?: Integrity;
};

export { Scopes, Imports, Integrity, ImportMap };
