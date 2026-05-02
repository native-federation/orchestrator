# Native federation orchestrator

🎉 **v4.0 is here — the orchestrator is now stable and ready for production use!**

A lightweight **runtime micro frontend orchestrator** that loads micro frontends built with native federation into any web page. It can cache dependencies across page reloads, making it perfect for traditional server-rendered hosts (PHP, Java, Rails, etc.) that refresh on navigation.

[![Verify library](https://github.com/native-federation/orchestrator/actions/workflows/verify-code.yaml/badge.svg)](https://github.com/native-federation/orchestrator/actions/workflows/verify-code.yaml)
![Coverage total](https://raw.githubusercontent.com/native-federation/orchestrator/badges/badges/coverage-total.svg)

> Read more in this in-depth article: [Migrating a stateful monolith to micro frontend architecture using native federation.](https://medium.com/@auke997/migrating-a-stateful-monolith-to-micro-frontends-using-native-federation-0572a1e181b4)

## Key Features

- ✨ **Zero Framework Dependencies** - Built in vanilla JS so it works with any frontend/backend technology
- 🚀 **Simple Drop-in Integration** - Add micro frontends with a single script tag
- 💾 **Advanced Caching** - Optimized for page-reload scenarios with flexible storage options like localStorage and sessionStorage
- 🔄 **Smart Dependency Resolution** - Automatic version conflict resolution and sharing based on the module federation mental model.
- 🌐 **Full native-federation compatibility** - Works with standard remoteEntry.json format.
- ⚡ **Lightweight & Fast** - Minimal bundle size (~80kb) with tree-shaking support.
- 🛠️ **Highly Configurable** - Extensive options and SDK for fine-tuning behavior.

### How it works

The library runs in the browser to orchestrate the integration of micro frontends into plain HTML pages. While the host application can be SSR, the micro frontends are loaded as ES modules at runtime, providing the benefits of micro frontend architecture without requiring a full SPA framework.

### Extends the Native Federation Ecosystem

This library provides an alternative runtime to [@softarc/native-federation-runtime](https://www.npmjs.com/package/@softarc/native-federation-runtime), extending native federation capabilities while maintaining full compatibility with the broader ecosystem. It can load any remotes that have been built using [@softarc/native-federation](https://www.npmjs.com/package/@softarc/native-federation) and expose a `remoteEntry.json` metadata file.

> Note: The orchestrator is fully backwards compatible and also works with native federation v3 remotes!

### What makes this orchestrator different?

Next to the advanced dependency resolver, this orchestrator offers the possibility to cache the remoteEntries in localStorage or sessionStorage. This way the downloaded dependencies can be reused, even over multiple routes. This is not an issue with SPA websites that don't reload the page on rerouting but essential to traditional websites where every route is a full page refresh. However this orchestrator can also be used in SPAs.

## Quick Start

Get up and running in under 2 minutes:

### 1. Add to your HTML page

```html
<!DOCTYPE html>
<html>
  <head>
    <title>My Application</title>

    <!-- Define your micro frontends (remotes) -->
    <script type="application/json" id="mfe-manifest">
      {
        "team/mfe1": "http://localhost:3000/remoteEntry.json",
        "team/mfe2": "http://localhost:4000/remoteEntry.json"
      }
    </script>

    <!-- Handle loaded modules -->
    <script>
      window.addEventListener(
        'mfe-loader-available',
        e => {
          // Load your remote modules, a remote can have multiple modules
          e.detail.loadRemoteModule('team/mfe1', './Button');
          e.detail.loadRemoteModule('team/mfe2', './Header');
        },
        { once: true }
      );
    </script>

    <!-- Include the orchestrator runtime -->
    <script src="https://unpkg.com/@softarc/native-federation-orchestrator@4.0.2/quickstart.mjs"></script>
  </head>
  <body>
    <!-- Use your loaded components -->
    <my-header></my-header>
    <my-button>Click me!</my-button>
  </body>
</html>
```

### 2. That's it! 🎉

Your micro frontends are now loaded and ready to use. The runtime handles the whole flow of fetching the remote entries (metadata files), resolving and caching the shared dependencies and finally (lazy) loading the remote modules.

### Available quickstart runtime

```html
<!-- Development and quick testing -->
<script src="https://unpkg.com/@softarc/native-federation-orchestrator@4.0.2/quickstart.mjs"></script>
```

## Advanced Usage

The quickstart is intended for experimenting. For production environments it is recommended to use a custom orchestrator based on the vnf library, this gives more control over the initialization process and allows for custom logging implementations like Bugsnag or Sentry rather than the default `consoleLogger`:

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';
import { consoleLogger, localStorageEntry } from '@softarc/native-federation-orchestrator/options';

const { loadRemoteModule, load } = await initFederation(
  // Manifest
  {
    'team/mfe1': 'http://localhost:3000/remoteEntry.json',
    'team/mfe2': 'http://localhost:4000/remoteEntry.json',
  },
  // Options
  {
    logLevel: 'error',
    logger: consoleLogger,
    storage: localStorageEntry,
    // ... see docs for all available options
  }
);

// Load specific modules
const ButtonComponent = await load('team/mfe1', './Button');
const HeaderComponent = await loadRemoteModule('team/mfe2', './Header');
```

> 📖 **See the [Configuration Guide](./docs/config.md) for complete configuration options**

## Documentation

| Guide                                                                                                         | Description                                |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [🚀 Getting Started](https://github.com/native-federation/orchestrator/blob/main/docs/getting-started.md)     | Detailed setup instructions and examples   |
| [🏗️ Architecture](https://github.com/native-federation/orchestrator/blob/main/docs/architecture.md)           | Understanding the native federation domain |
| [⚙️ Configuration](https://github.com/native-federation/orchestrator/blob/main/docs/config.md)                | Complete configuration reference           |
| [🔄 Version Resolution](https://github.com/native-federation/orchestrator/blob/main/docs/version-resolver.md) | How dependency conflicts are resolved      |
| [🔒 Security & Trusted Types](https://github.com/native-federation/orchestrator/blob/main/docs/security.md)   | CSP setup and the built-in Trusted Types policy |

## Example repositories

| Guide                                                                                                          | Description                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [📖 Vanilla JS/HTML host](https://github.com/Aukevanoost/native-federation-examples/tree/orchestrator)         | Shows how the orchestrator can be used in a simple HTML page.                             |
| [📖 Angular host (native-federation v3)](https://github.com/Aukevanoost/native-federation-examples-ng)         | Shows how the orchestrator can be used in an Angular monorepo using Native-federation v3. |
| [📖 Angular host (native-federation v4)](https://github.com/Aukevanoost/native-federation-examples-ng/tree/v4) | Shows how the orchestrator can be used in an Angular monorepo using Native-federation v4. |

## Native Federation Ecosystem

This library is part of the broader native federation

| ecosystem:                                                                                                   | Purpose                     |
| ------------------------------------------------------------------------------------------------------------ | --------------------------- |
| [@softarc/native-federation](https://www.npmjs.com/package/@softarc/native-federation)                       | Core build toolchain        |
| [@softarc/native-federation-runtime](https://www.npmjs.com/package/@softarc/native-federation-runtime)       | Core runtime                |
| **orchestrator**                                                                                             | Enhanced runtime            |
| [@angular-architects/native-federation](https://www.npmjs.com/package/@angular-architects/native-federation) | Build toolchain for Angular |

> ✅ **Full compatibility** with standard remoteEntry.json format ensures seamless interoperability

## More information

Read here more about the ecosystem!

- [Micro Frontends with Angular and Native Federation](https://blog.angular.dev/micro-frontends-with-angular-and-native-federation-7623cfc5f413) - Manfred Steyer
- [Micro Frontends with Modern Angular – Part 1: Standalone and esbuild](https://www.angulararchitects.io/blog/micro-frontends-with-modern-angular-part-1-standalone-and-esbuild/) - Manfred Steyer
- [Migrating a stateful monolith to micro frontend architecture using native federation.](https://medium.com/@auke997/migrating-a-stateful-monolith-to-micro-frontends-using-native-federation-0572a1e181b4) - Aukevanoost
