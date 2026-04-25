# AL Companion — Plugins

This folder contains the feature plugins for AL Companion. Each plugin is self-contained: it registers a VS Code command (and optionally a parser plugin) and exposes a `registerCommands(context)` function that is wired up in [`index.ts`](index.ts).

---

## Event Subscriber Search (`eventSubscriberPlugin.ts`)

### What it does

Provides the **`AL Companion: Search Event Subscriber`** command, which guides the user through a 3-step Quick Pick to find every subscriber of a given AL event across all loaded packages and local workspace files.

### How it works

**Parser plugin** — `eventSubscriberPlugin` is registered as an `AlParserPlugin`. After the core parser has finished scanning an AL object, the plugin inspects every function's `attributes` array for an `[EventSubscriber(...)]` attribute:

```
[EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", OnBeforePost, '', true, true)]
```

Supported second-argument forms:
- `Codeunit::"Quoted Name"` / `Table::Database::"Quoted Name"`
- `Codeunit::UnquotedName`
- `Codeunit::50100` (numeric id)
- `50100` (naked numeric id)

Matches are stored in `AlObject.eventSubscribers` as `AlEventSubscriber` records containing the publisher type, publisher name, event name, and optional element name.

**Search command** — the 3-step flow:

1. **Pick publisher object** — a de-duplicated list of all publisher objects that have at least one subscriber in the loaded packages.
2. **Pick event name** — events available on the selected publisher object.
3. **Pick element** *(optional)* — for table/page events that target a specific field or action. "Any element" skips the filter.

After picking, all matching subscribers are shown in a result list. Selecting one:
- **Local `.al` file** → opens the file and scrolls to the subscriber function.
- **Package `.app` file** → extracts the AL source from the ZIP and opens it as a read-only preview; cursor lands on the subscriber function.

### Extending

To add support for a new attribute format, update the `EVENT_SUB_RE` regex in `eventSubscriberPlugin.ts`.

---

## Quick Search — Local Files (`localSearchPlugin.ts`)

### What it does

Provides the **`AL Companion: Quick Search`** command: a single-step fuzzy Quick Pick over every AL symbol in the local workspace (objects, procedures/triggers, table fields, page actions, enum values, report columns, …).

### How it works

**Result building** — on first invocation after a package reload, `buildResults()` walks every local `AlObject` (identified by a non-null `sourceFilePath`) and produces a flat `SearchResult[]` — one entry per object, plus one per function and one per element. Each entry stores:

| Field | Content |
|---|---|
| `label` | VS Code icon glyph + symbol name (+ numeric ID where applicable) |
| `description` | Object type / extends / caption context |
| `detail` | Workspace-relative file path |
| `memberName` | Lower-cased procedure / field / action / object name |
| `captionName` | Lower-cased caption (empty when absent) |
| `objectName` | Lower-cased AL object name |
| `extendsName` | Lower-cased extends target (empty when none) |
| `fileName` | Lower-cased `.al` filename without extension |
| `objectType` | Lower-cased object type string |
| `extraText` | Compact fallback string: object ID, element ID, kind keyword (`object` / `trigger` / `procedure` / element kind) |

**Caching** — the result array is cached until the next package reload. The cache is keyed by `storeVersion` (a monotonically-increasing counter in `packageStore.ts` that advances after every successful `reloadAllPackages()` call). This means:
- The first search after a reload rebuilds the array from scratch.
- Every subsequent search reuses the same array (score/description fields are reset at the start of each command invocation).

**Scoring** — as the user types, `scoreAndFilter` splits the query into whitespace-separated tokens and calls `scoreToken` for each result × token pair. A result is **excluded** if any single token scores 0. Otherwise the average per-token score (0–100) is shown as a percentage prefix in the description line and used for sorting.

Token scoring priority (highest → lowest):

| Score | Condition |
|---|---|
| 100 | `memberName` exact match |
| 95 | `captionName` exact match |
| 85 | `memberName` starts with token |
| 80 | `captionName` starts with token |
| 75 | `objectName` exact match |
| 70 | token at word boundary inside `memberName` |
| 65 | token at word boundary inside `captionName` |
| 60 | `objectName` starts with token |
| 55 | `memberName` contains token |
| 55 | `extendsName` starts with token |
| 50 | `captionName` contains token |
| 50 | `fileName` starts with token |
| 48 | token at word boundary inside `objectName` |
| 43 | token at word boundary inside `extendsName` |
| 38 | token at word boundary inside `fileName` |
| 33 | `objectName` contains token |
| 28 | `extendsName` contains token |
| 23 | `fileName` contains token |
| 12 | `objectType` exact match (e.g. `codeunit`, `table`) |
| 8 | `objectType` starts with token (e.g. `page` → `pageextension`) |
| 5 | `objectType` contains token (e.g. `extension`) |
| 10 | token found in `extraText` (numeric IDs, kind keywords) |

**Navigation** — selecting a result opens the `.al` file with the cursor centred on the matched symbol's line.

### Memory footprint

Because each `SearchResult` stores token-ready lower-cased strings in dedicated fields (rather than one big concatenated search string), the per-item overhead is kept small. The `extraText` field contains **only** data that has no dedicated field (numeric IDs and one kind keyword), which is typically ≤ 20 characters per item.

---

## Navigate to Referenced Object (`navigateToObjectPlugin.ts`)

### What it does

Provides the **`AL Companion: Navigate to Referenced Object`** command (`Alt+Shift+O`).  When invoked from an open `.al` file (local or read-only from a `.app` package), it collects every navigatable object reference on the active AL object and either opens the target directly or presents a Quick Pick when multiple references are available.

Supported references out of the box:

| Object type | References offered |
|---|---|
| `TableExtension` | Extends Table |
| `PageExtension` | Extends Page · Source Table (resolved from the base page) |
| `ReportExtension` | Extends Report |
| `EnumExtension` | Extends Enum |
| `PermissionSetExtension` | Extends PermissionSet |
| `Page` | Source Table |

### How it works

**Parser plugin** — `navigateToObjectPlugin` is registered as an `AlParserPlugin`.  After the core parser has finished, the plugin scans the raw source text for:

- `namespace <name>;` — stored in `obj.namespace`.
- `using <name>;` — accumulated into `obj.usings[]`.
- `SourceTable = <name>;` (Page objects only) — stored in `obj.sourceTable`.

These fields are used at command invocation time for namespace-aware resolution and do not affect the core symbol model.

**Extensible collector registry** — rather than hard-coding every possible reference property type, the plugin exposes an exported `registerReferenceCollector()` function.  Any plugin can call it at module level to contribute additional reference types (e.g. `LookupPageId`, `DrillDownPageId`):

```typescript
import { registerReferenceCollector } from './navigateToObjectPlugin';

registerReferenceCollector((obj, packages) => {
    if (obj.type !== 'Table') { return []; }
    const lookupPage = /* read LookupPageId from obj.extra or source */;
    if (!lookupPage) { return []; }
    return [{
        label: `$(go-to-file) Lookup Page: "${lookupPage}"`,
        description: 'Page',
        refName: lookupPage,
        targetTypes: ['Page'],
    }];
});
```

**Namespace-aware resolution** — `resolveObjectReference()` finds the best single match for a reference name by ranking candidates:

1. Object in the **same namespace** as the source object (e.g. another object in `MyCompany.MyApp`).
2. Object in a namespace listed in the source object's **`using` directives**.
3. Object with **no namespace** — global symbols, base BC objects such as `Customer` or `Item`.
4. Any other match (different namespace, not imported) — the fallback.

Within each priority tier the first match found wins, consistent with the AL compiler's own resolution behaviour.  In a well-formed project this produces exactly one result for every reference.

**Navigation** — after the target `AlObject` is resolved:

- **Local `.al` file** → opens the file and positions the cursor on the object declaration line.
- **Package `.app` file** → extracts the AL source from the ZIP via the `al-companion-app:` virtual document provider and opens it in read-only preview mode; cursor lands on the object declaration line.

### Extending

To support new reference property types (e.g. page properties such as `LookupPageId`) without modifying this plugin:

1. Parse the property value into `obj.extra` using your own `AlParserPlugin`.
2. Call `registerReferenceCollector(...)` at module level in your plugin, reading from `obj.extra`.
3. No changes to `navigateToObjectPlugin.ts` are required.

---

## Adding a new plugin

1. Create a new `.ts` file in this folder (e.g. `myFeaturePlugin.ts`).
2. Optionally implement an `AlParserPlugin` and call `registerPlugin()` at module level — this wires it into the core parser so it runs on every parsed AL object automatically.
3. Implement your VS Code commands.
4. Export `registerCommands(context: vscode.ExtensionContext): void`.
5. Import it in [`index.ts`](index.ts) and call `registerCommands` inside `registerAllPluginCommands`.
