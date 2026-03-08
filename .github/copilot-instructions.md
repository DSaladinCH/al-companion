# AL Companion — Copilot Instructions

## Project overview

AL Companion is a TypeScript VS Code extension that helps developers navigate and explore Microsoft AL / Business Central projects. It parses `.al` source files and `.app` package ZIPs, builds an in-memory object model, and exposes VS Code commands (Quick Picks, tree views, etc.) backed by that model.

- **Language / runtime**: TypeScript 5, Node.js, VS Code Extension API (`vscode`)
- **Build**: `npm run compile` (one-shot `tsc`) · `npm run watch` (incremental)
- **Lint**: ESLint 9 with TypeScript-ESLint (`npm run lint`)
- **Test**: `npm test` (compiles then runs `@vscode/test-cli`)
- **Package/publish**: `npm run package` / `npm run publish` (uses `vsce`)
- **Output**: compiled JS goes to `out/`, mirrors the `src/` tree

---

## Repository layout

```
src/
  extension.ts              VS Code activate() entry point
  al/
    types.ts                Core AL model interfaces (AlObject, AlFunction, AlElement, …)
    parser.ts               Line-by-line AL source parser + plugin registry
    packageStore.ts         In-memory package store; drives reloadAllPackages()
    packageReader.ts        Reads .app ZIP files (manifests + AL source entries)
    logger.ts               Thin wrapper around the AL Companion output channel
    commands.ts             Shared/utility commands (if any)
    plugins/
      index.ts              Imports every plugin and wires up registerAllPluginCommands()
      eventSubscriberPlugin.ts  Parser plugin + Event Subscriber search command
      localSearchPlugin.ts      Quick Search (local files) command
      parserUtils.ts        Shared parser utility functions used by plugins
      README.md             Developer reference for all plugins
```

---

## Core data model (`src/al/types.ts`)

| Type | Purpose |
|---|---|
| `AlPackage` | A loaded `.app` file or local workspace project; holds `objects: AlObject[]` |
| `AlObject` | One AL object (table, codeunit, page, …); holds `functions`, `elements`, `eventSubscribers` |
| `AlFunction` | A procedure or trigger; carries `attributes: string[]` for decorator parsing |
| `AlElement` | A non-function member: table field, page action, enum value, report column |
| `AlEventSubscriber` | Decoded `[EventSubscriber(...)]` attribute on a function |

**Key conventions**:
- All line numbers are **1-based**.
- `sourceFilePath` (non-null) → symbol lives in a local `.al` file.
- `zipEntryName` (non-null) → symbol comes from inside a `.app` ZIP.
- `obj.extra` is an open `Record<string, unknown>` for plugin-specific data.

---

## Package store (`src/al/packageStore.ts`)

- `getPackages()` — returns all loaded packages from the in-memory `Map`.
- `reloadAllPackages()` — full reload pipeline (scan → filter → parse → local project walk); ends by incrementing `storeVersion`.
- `getStoreVersion()` — monotonically increasing integer; plugins use this to cheaply invalidate caches without callbacks.

---

## Parser and plugin system (`src/al/parser.ts`)

`parseAlSource(source, fileName)` runs the core line-by-line parser and then calls every registered `AlParserPlugin` in order.

```ts
export type AlParserPlugin = (source: string, object: AlObject) => boolean;
export function registerPlugin(plugin: AlParserPlugin): void;
```

**Plugin rules**:
- Call `registerPlugin()` at **module load time** (top level, outside any function).
- Plugins must not import from each other; share utilities via `parserUtils.ts`.
- Plugins write to `obj.extra`, `obj.eventSubscribers`, or other fields — they must **not** replace `obj.functions` or `obj.elements` (managed by the core parser).
- The plugin module must be imported in `plugins/index.ts` to take effect.

---

## Adding a new feature

### New parser plugin
1. Create `src/al/plugins/myPlugin.ts`.
2. Implement your `AlParserPlugin` and call `registerPlugin(myPlugin)` at module level.
3. Export `registerCommands(context: vscode.ExtensionContext): void`.
4. Import in `plugins/index.ts`; call `registerCommands` inside `registerAllPluginCommands`.

### New VS Code command
1. Add the command to `package.json` under `contributes.commands`.
2. Register it in the appropriate plugin's `registerCommands` (or in `extension.ts` for core commands).

### New setting
- Add it to `package.json` under `contributes.configuration.properties`.
- Read it with `vscode.workspace.getConfiguration('al-companion').get<T>('settingName')`.

---

## Coding conventions

- **Formatting**: 4-space indentation, no trailing whitespace, Unix line endings.
- **Imports**: group `vscode` first, then Node built-ins, then local imports; no barrel re-exports beyond `plugins/index.ts`.
- **Async**: use `async/await`; never `.then()` chains for new code.
- **Error handling**: surface user-visible errors via `vscode.window.showErrorMessage`; use `logger.error` for internal diagnostics. Never swallow errors silently.
- **Comments**: block comments above exported functions; inline comments only where logic is non-obvious.
- **No over-engineering**: keep helpers scoped to where they are used; don't create abstractions for one-off operations.
- **Security**: never construct shell commands from user input; never expose internal paths or stack traces in user-facing messages.

---

## Performance guidelines

- **Cache with storeVersion**: if a command needs to build a derived data structure from all packages, cache it keyed by `getStoreVersion()` — rebuild only when the version changes.
- **Concurrency**: use the sliding-window worker pattern (see `packageStore.ts`) rather than fixed-chunk `Promise.all` for large sets of async tasks.
- **Memory**: store only what cannot be trivially recomputed; avoid duplicating strings that already exist in a dedicated typed field.
- **Quick Pick responsiveness**: `onDidChangeValue` handlers must be synchronous or near-instant; offload any heavy computation to the initial `buildResults()` step.
