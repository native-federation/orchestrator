# Contributing

Thanks for being interested in contributing! We welcome all meaningful contributions that help improve the library.

## Getting Started

We love seeing fresh ideas and improvements! Before diving into major architectural changes or large refactors, it's usually helpful to chat with us first in an issue - we're always happy to discuss the best approach and can save you time.

For the smoothest experience, we find that contributions focusing on functionality, bug fixes, and meaningful improvements tend to have the quickest path to merge. Style tweaks are great, but if that's the main focus, consider bundling them with a feature or fix to maximize impact.

To find your way around the codebase, see [Source Code Organization](./docs/architecture.md#source-code-organization) - in short: one folder per published subpath under `src/lib/` (`core/`, `registry/`, `audit/`, `node/`, `module-federation/`), with the `*.index.ts` barrels at the root of `src/lib/` defining each subpath's public API.

Every arrow below means "may import" - this direction is enforced by ESLint, so a PR that crosses a flow boundary (or imports a `*.index.ts` barrel from internal code) will fail the lint step:

```mermaid
graph LR
    E["src/scripts/<br/>quickstart · init-registry · node-loader<br/>(standalone script bundles)"]

    subgraph lib ["src/lib"]
        BARRELS["*.index.ts barrels<br/>published API, one per subpath"]

        CORE["core/<br/>initFederation + initRemoteEntry<br/>hexagonal layers 1.domain → 5.di<br/>(serves '.', /sdk, /options)"]
        REGISTRY["registry/<br/>event registry<br/>(/registry)"]
        AUDIT["audit/<br/>externals audit<br/>(/audit)"]
        NODE["node/<br/>fs adapters · loader client<br/>initNodeFederation (/node)"]
        MF["module-federation/<br/>getShared share infos<br/>(/module-federation)"]

        UTILS["utils/<br/>Optional · path · cloneEntry"]
        TESTING["testing/<br/>vitest mocks, used by *.spec.ts only<br/>(not published)"]
    end

    E --> BARRELS
    BARRELS --> CORE
    BARRELS --> REGISTRY
    BARRELS --> AUDIT
    BARRELS --> NODE
    BARRELS --> MF

    AUDIT -->|contracts| CORE
    NODE -->|flows, own adapters injected| CORE
    MF -->|domain, contracts| CORE

    CORE --> UTILS
    REGISTRY --> UTILS
    NODE --> UTILS
    MF --> UTILS
    TESTING -.-> CORE

    style CORE fill:#e8f0fe,stroke:#4285f4
    style BARRELS fill:#fef7e0,stroke:#f9ab00
```

Notably absent arrows: `core` never imports a flow folder, and `registry`, `audit` and `node` never import each other.

## Quick Start

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Build the library: `pnpm build`
4. Create a branch: `git checkout -b my-feature`
5. Make your changes
6. Lint your code: `pnpm lint`
7. Test your code: `pnpm test`
8. Push your branch and open a PR

## Pull Request Guidelines

- Include tests for any new features
- Update documentation if needed
- Follow our coding style (eslint)
- Keep PRs focused - one feature or bug fix per PR

## Commit Messages

Please use clear commit messages:

```
feat: add new feature
fix: resolve issue
docs: update readme
```

## Releasing (maintainers)

Releases are staged by CI and approved by a human with a security key; nobody publishes directly.

1. Bump `version` in `package.json` in a reviewed PR and merge it.
2. Push a signed tag matching that version: `git tag -s vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. Prereleases (`vX.Y.Z-rc.0`) are staged under the `next` dist-tag.
3. The [Release workflow](.github/workflows/release.yml) verifies, builds, packs `dist/` and runs `npm stage publish --provenance`. Its job summary lists the tarball contents and shasum.
4. On npmjs.com → **Staged Packages** (or `npm stage list @softarc/native-federation-orchestrator`), check that the shasum, version and dist-tag match the job summary, then **Approve** and touch your security key. Reject anything unexpected with `npm stage reject <stage-id>`.
5. Once the version is live, publish the GitHub Release notes.

A staged version is not installable until approved, so don't announce a release before step 4.

## Need Help?

Open an issue if you:
- Find a bug
- Want to suggest a feature
- Have questions about the code

Thanks for contributing! 🎉