const typescript = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');
const prettier = require('eslint-plugin-prettier');
const fs = require('fs');
const path = require('path');

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
const CORE_FLOW_BOUNDARY = flowBoundary(['registry', 'audit', 'node', 'testing']);

// Core's layers (see docs/architecture.md §"Dependency rules"). The domain is pure: no outer layer of core.
const DOMAIN_PURITY = {
    group: ['**/2.app/**', '**/3.adapters/**', '**/4.config/**', '**/5.di/**'],
    message: '1.domain is pure: it imports nothing from core\'s outer layers.',
};
// Pooling builds on externals, never the other way round.
const EXTERNALS_BELOW_POOLING = {
    group: ['**/1.domain/pooling/**', '../pooling/**'],
    message: '1.domain/externals is below pooling: it never imports 1.domain/pooling.',
};
// Only 5.di (and the test harness) wires the pipeline steps.
const NO_STEPS = {
    group: ['**/steps/**'],
    message: 'Only 5.di wires pipeline steps. Move what you need into 1.domain, or into the step that owns it.',
};
// The steps are what 5.di wires, read off its factories so adding a step needs no edit here. Import
// specifiers always use `/`, whatever the OS. A step never imports another; templates such as
// store-remote-entry and apply-winner are not steps.
const DI_DIR = path.join(__dirname, 'src', 'lib', 'core', '5.di');
const STEPS = [...new Set(
    fs.readdirSync(DI_DIR)
        .filter(file => file.endsWith('.factory.ts'))
        .flatMap(file => [...fs.readFileSync(path.join(DI_DIR, file), 'utf8').matchAll(/from '[^']*2\.app\/steps\/([^']+)'/g)])
        .map(match => path.posix.basename(match[1]))
)];
const NO_OTHER_STEP = {
    group: STEPS.map(step => `**/${step}`),
    message: 'A step never imports another step. Share through 1.domain or a template instead.',
};

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
            
            'no-restricted-imports': noRestrictedImports([NO_STEPS]),

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
        files: ['src/lib/testing/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports() }
    },
    {
        files: ['src/lib/core/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([CORE_FLOW_BOUNDARY, NO_STEPS]) }
    },
    {
        files: ['src/lib/core/1.domain/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([CORE_FLOW_BOUNDARY, DOMAIN_PURITY]) }
    },
    {
        files: ['src/lib/core/1.domain/externals/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([CORE_FLOW_BOUNDARY, DOMAIN_PURITY, EXTERNALS_BELOW_POOLING]) }
    },
    {
        files: ['src/lib/core/2.app/steps/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([CORE_FLOW_BOUNDARY, NO_OTHER_STEP]) }
    },
    {
        files: ['src/lib/core/5.di/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([CORE_FLOW_BOUNDARY]) }
    },
    {
        files: ['src/lib/registry/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['core', 'audit', 'node', 'testing']), NO_STEPS]) }
    },
    {
        files: ['src/lib/audit/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['registry', 'node', 'testing']), NO_STEPS]) }
    },
    {
        files: ['src/lib/node/**/*.ts'],
        rules: { 'no-restricted-imports': noRestrictedImports([flowBoundary(['registry', 'audit', 'testing']), NO_STEPS]) }
    }
];