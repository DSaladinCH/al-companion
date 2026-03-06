# Change Log

All notable changes to the AL Companion extension will be documented in this file.

Format follows [Keep a Changelog](http://keepachangelog.com/).

## [0.1.0] - 2026-03-07

### Added
- Automatic package loading on workspace open — scans `.alpackages` (or `al.packageCachePath`) and loads all declared dependencies
- Dependency-aware version selection — picks the highest version satisfying the minimum declared in `app.json`
- Microsoft platform package support — System, System Application, Base Application and Application are always loaded
- **Search Event Subscriber** command — 3-step guided Quick Pick (publisher → event → element)
- Navigate to subscriber source — opens local `.al` files directly; extracts and opens AL source from `.app` packages as read-only virtual documents with syntax highlighting
- `al-companion.debugLogging` setting for verbose output channel logging
- Plugin architecture — parser plugins can extend object data; event subscriber detection is a built-in plugin
