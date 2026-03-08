<p align="center">
  <img src="https://raw.githubusercontent.com/DSaladinCH/al-companion/refs/heads/main/logo.png" alt="AL Companion" width="140" />
</p>

<h1 align="center">AL Companion</h1>

<p align="center">
  Navigate and explore Microsoft AL / Business Central packages right inside VS Code.
</p>

<p align="center">
  <a href="https://github.com/DSaladinCH/al-companion/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/DSaladinCH/al-companion?style=for-the-badge" alt="License" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DSaladin.al-companion">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DSaladin.al-companion?label=Version&style=for-the-badge" alt="Marketplace Version" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DSaladin.al-companion">
    <img src="https://img.shields.io/visual-studio-marketplace/d/DSaladin.al-companion?color=darkgreen&label=Downloads&style=for-the-badge" alt="Marketplace Downloads" />
  </a>
</p>

---

## Features

### ⚡ Automatic Package Loading

AL Companion automatically loads your dependency packages when you open an AL project (any workspace containing an `app.json`). It respects:

- The `al.packageCachePath` workspace setting — uses your custom cache directory if configured, otherwise falls back to `.alpackages`
- Your `app.json` dependency list — only loads packages you actually depend on (plus the Microsoft platform packages: System, System Application, Base Application, Application)
- Version constraints — when multiple versions of a package exist in the cache, the highest version satisfying your minimum requirement is selected

### 🔍 Search Event Subscribers

Quickly find all event subscribers across all loaded packages and your local project files using a guided 3-step Quick Pick:

1. **Publisher object** — pick the object that publishes the event (e.g. `Codeunit "Sales-Post"`)
2. **Event name** — pick the event (e.g. `OnBeforePostDocument`)
3. **Element** *(optional)* — filter by field or action name for table/page events

After selecting a subscriber from the results list:
- **Local `.al` files** — the file opens directly and VS Code jumps to the subscriber function
- **Package `.app` files** — the AL source is extracted from the package and opened as a read-only document with full AL syntax highlighting, with the cursor placed at the subscriber function

### ⚡ Quick Search (Local Files)

Instantly navigate to any AL symbol in your local workspace using a single fuzzy Quick Pick. Open it with the **`AL Companion: Quick Search`** command and start typing — there is no separate "go to file" vs. "go to symbol" step.

You can combine any of the following tokens in any order, separated by spaces:

| What you type | What it matches |
|---|---|
| Part of an object, field, or procedure name | Names and captions of objects, fields, actions, enum values, and procedures/triggers |
| An object type keyword (e.g. `codeunit`, `page`, `table`) | Filters results to that object type |
| A numeric ID (e.g. `50100`) | Matches objects or fields by their numeric ID |
| `trigger` or `procedure` | Narrows results to triggers or developer procedures |
| Any element kind (`field`, `action`, `column`, `enumvalue`) | Filters to that element kind |

Every token must match — results are ranked by a per-token score so the best matches appear at the top. Selecting a result opens the `.al` file and places the cursor at the matching symbol.

> Results are built once per package-reload and cached, so repeated searches are near-instant.

---

## Commands

| Command | Description |
|---|---|
| `AL Companion: Reload Packages` | Re-scan package cache directories and reload all packages |
| `AL Companion: Search Event Subscriber` | Open the guided event subscriber search |
| `AL Companion: Quick Search` | Open the fuzzy quick search over all local AL symbols |

## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `al-companion.debugLogging` | `boolean` | `false` | Enable verbose debug logging to the *AL Companion* output channel |

## Requirements

- VS Code 1.109.0 or later
- An AL project with an `app.json` file (Microsoft AL extension not required)

## Known Issues

Please report issues on [GitHub](https://github.com/DSaladinCH/al-companion/issues).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## Logo
The logo has been generated with Google Nano Banana 2