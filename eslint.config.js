const typescript = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');
const prettier = require('eslint-plugin-prettier');

// Entry-point barrels (lib/*.index.ts) define the published package API.
// Internal code must import concrete modules so the dependency graph
// between subpackages stays visible and free of accidental cycles.
const ENTRY_BARRELS = {
    group: ['**/*.index', '**/*.index.ts'],
    message: 'Entry-point barrels (*.index.ts) are for package consumers only. Import the concrete module instead.',
};

// Dependency direction between the flow folders: registry, audit and node may
// depend on core (and lib/utils), never on each other; core depends on no flow.
const noRestrictedImports = (forbidden = []) => ['error', { patterns: [ENTRY_BARRELS, ...forbidden] }];
const flowBoundary = (folders) => ({
    group: folders.map(f => `lib/${f}/*`),
    message: 'Crossing a flow boundary: registry/audit/node may depend on core, never on each other; core depends on no flow.',
});

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'coverage/**',
            '**/*.js',
            '**/*.d.ts',
            '**/*.spec.ts',
            '**/*.mock.ts',
            'build.ts'
        ]
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: __dirname,
            },
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        },
        plugins: {
            '@typescript-eslint': typescript,
            'prettier': prettier
        },
        rules: {
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/consistent-type-imports': ['error', {
                prefer: 'type-imports',
            }],
            
            'no-restricted-imports': noRestrictedImports(),

            // General rules
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'eqeqeq': ['error', 'always'],
            'no-unused-expressions': 'error',
            'no-duplicate-imports': 'error',
            'prefer-const': 'error',
        },
        settings: {
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                    project: './tsconfig.json',
                }
            }
        }
    },
    {
        files: ['src/lib/core/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['registry', 'audit', 'node', 'testing'])]) }
    },
    {
        files: ['src/lib/registry/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['core', 'audit', 'node', 'testing'])]) }
    },
    {
        files: ['src/lib/audit/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['registry', 'node', 'testing'])]) }
    },
    {
        files: ['src/lib/node/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['registry', 'audit', 'testing'])]) }
    }
];