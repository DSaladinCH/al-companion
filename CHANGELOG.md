# Change Log
All notable changes to the AL Companion extension will be documented in this file.

## [v0.2.1] - 2026-03-09
### Fixed
- Extension failed to activate with "Cannot find module 'jszip'" after marketplace install — dependencies are now bundled into the extension output using esbuild

## [v0.2] - 2026-03-09
### Added
- **Quick Search** command — search AL symbols (objects, functions, fields) across all loaded packages with instant filtering
- **Incremental local file updates** — `.al` files in the workspace are re-parsed automatically on save, keeping the in-memory model up to date without a full reload

### Fixed
- Event subscriber parsing now correctly handles element (field) names in all quote styles: double-quoted (`"Sell-to Customer No."`), single-quoted (`'No.'`), and unquoted (`FieldName`) — previously only single-quoted element names were recognised, causing `OnAfterValidateEvent` and similar field-level events to be silently dropped
- Multi-line `[EventSubscriber(...)]` attributes (where the declaration wraps across lines) are now accumulated and parsed correctly

### Security
- Updated `serialize-javascript` dependency to address a known vulnerability

## [v0.1] - 2026-03-07
### Added
- Automatic package loading on workspace open — scans `.alpackages` (or `al.packageCachePath`) and loads all declared dependencies
- Dependency-aware version selection — picks the highest version satisfying the minimum declared in `app.json`
- Microsoft platform package support — System, System Application, Base Application and Application are always loaded
- **Search Event Subscriber** command — 3-step guided Quick Pick (publisher → event → element)
- Navigate to subscriber source — opens local `.al` files directly; extracts and opens AL source from `.app` packages as read-only virtual documents with syntax highlighting
- `al-companion.debugLogging` setting for verbose output channel logging
- Plugin architecture — parser plugins can extend object data; event subscriber detection is a built-in plugin

[v0.2.1]: https://github.com/DSaladinCH/al-companion/compare/v0.2...v0.2.1
[v0.2]: https://github.com/DSaladinCH/al-companion/compare/v0.1...v0.2
[v0.1]: https://github.com/DSaladinCH/al-companion/releases/tag/v0.1