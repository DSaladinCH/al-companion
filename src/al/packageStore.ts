import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AlPackage, AlAppJsonDependency, AlAppManifest, AlObject } from './types';
import { readAppFile, readAppManifest } from './packageReader';
import { parseAlSource } from './parser';
import * as logger from './logger';

/**
 * In-memory store of all parsed AL packages.
 * Keys are AlPackage.id strings.
 */
const store = new Map<string, AlPackage>();

export function getPackages(): AlPackage[] {
    return [...store.values()];
}

export function getPackageById(id: string): AlPackage | undefined {
    return store.get(id);
}

export function clear(): void {
    store.clear();
}

/**
 * Monotonically-increasing counter bumped after every completed
 * `reloadAllPackages()` call. Plugins can compare against a locally-stored
 * value to cheaply detect when their caches are stale.
 */
let storeVersion = 0;

export function getStoreVersion(): number {
    return storeVersion;
}

// ---------------------------------------------------------------------------
// Incremental local-file update
// ---------------------------------------------------------------------------

/**
 * Re-parse a single local `.al` file and update the in-memory package that
 * owns it, without touching any other package or file.
 *
 * This is called by the FileSystemWatcher in extension.ts whenever a local
 * workspace `.al` file is created, changed, or deleted.  `storeVersion` is
 * bumped so that plugin caches (e.g. localSearchPlugin) are invalidated.
 */
export async function reloadLocalFile(absoluteFilePath: string): Promise<void> {
    // Find the local package whose workspace folder contains this file.
    // Local packages have their `filePath` set to the workspace's app.json.
    const localPkg = [...store.values()].find(pkg => {
        if (!pkg.filePath.toLowerCase().endsWith('app.json')) { return false; }
        const folderPath = path.dirname(pkg.filePath);
        return absoluteFilePath.startsWith(folderPath + path.sep);
    });

    if (!localPkg) {
        logger.debug(`reloadLocalFile: no local package found for ${absoluteFilePath}`);
        return;
    }

    // Drop stale objects originating from this file.
    localPkg.objects = localPkg.objects.filter(obj => obj.sourceFilePath !== absoluteFilePath);

    // Re-parse and insert the new object(s) — skip when the file was deleted.
    if (fs.existsSync(absoluteFilePath)) {
        try {
            const source = (await fs.promises.readFile(absoluteFilePath, 'utf8')).replace(/^\uFEFF/, '');
            const obj = parseAlSource(source, absoluteFilePath);
            if (obj) {
                obj.sourceFilePath = absoluteFilePath;
                localPkg.objects.push(obj);
            }
        } catch (err) {
            logger.error(`reloadLocalFile: cannot read ${absoluteFilePath}`, err);
        }
    }

    storeVersion++;
    logger.log(`Refreshed symbols for: ${path.basename(absoluteFilePath)}`);
}

// ---------------------------------------------------------------------------
// Discovery & loading
// ---------------------------------------------------------------------------

/**
 * Scan all open workspace folders for AL projects and load their dependency
 * packages from the package cache directories.
 *
 * Only packages that are declared as dependencies in an app.json are loaded.
 * When multiple versions of the same package exist in the cache, the highest
 * version that satisfies the minimum version requirement is chosen.
 * When multiple projects declare the same dependency, a single package file
 * is loaded (the latest version satisfying the highest minimum required).
 */
export async function reloadAllPackages(): Promise<void> {
    store.clear();

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        logger.log('No workspace folders open.');
        return;
    }

    // ── Step 1: Collect all declared dependencies and package cache dirs ────
    // Keyed by "publisher|name" (lower-cased) → highest minimum version seen
    const requiredDeps = new Map<string, AlAppJsonDependency>();
    // All candidate .app file paths across every workspace folder's cache dir
    const candidateFiles: string[] = [];

    for (const folder of folders) {
        const folderPath = folder.uri.fsPath;
        const appJsonPath = path.join(folderPath, 'app.json');
        if (!fs.existsSync(appJsonPath)) {
            logger.debug(`Skipping non-AL folder: ${folderPath}`);
            continue;
        }

        // Read declared dependencies
        const deps = await readAppJsonDependencies(appJsonPath);
        logger.debug(`${deps.length} dependencies declared in ${appJsonPath}`);
        for (const dep of deps) {
            const key = depKey(dep);
            const existing = requiredDeps.get(key);
            // Keep the highest minimum version across all projects
            if (!existing || compareVersionStrings(dep.version, existing.version) > 0) {
                requiredDeps.set(key, dep);
            }
        }

        // Resolve package cache directory
        const packageCachePath = vscode.workspace
            .getConfiguration('al', folder.uri)
            .get<string>('packageCachePath');

        let packageDir: string;
        if (packageCachePath) {
            packageDir = path.isAbsolute(packageCachePath)
                ? packageCachePath
                : path.join(folderPath, packageCachePath);
            logger.debug(`Using al.packageCachePath: ${packageDir}`);
        } else {
            packageDir = path.join(folderPath, '.alpackages');
        }

        if (!fs.existsSync(packageDir)) {
            logger.debug(`No package cache directory found at ${packageDir}`);
            continue;
        }

        candidateFiles.push(...collectAppFiles(packageDir));
    }

    if (candidateFiles.length === 0) {
        logger.log('No .app packages found in any AL workspace folder.');
    }

    logger.log(`Resolving ${requiredDeps.size} declared dependency(s) from ${candidateFiles.length} candidate file(s).`);

    // ── Step 2: Read manifests of all candidates ────────────────────────────
    // Use the PackageReader to read all manifests consistently.
    // This ensures all package metadata (publisher, name, version, id) is
    // extracted uniformly from either app.json or NavxManifest.xml.
    const manifests: AlAppManifest[] = [];
    if (candidateFiles.length > 0) {
        const results = await Promise.all(candidateFiles.map(f => readAppManifest(f)));
        for (const m of results) {
            if (m) { manifests.push(m); }
        }
    }

    // Group all manifests by "publisher|name" so we can deduplicate versions.
    const manifestsByKey = new Map<string, AlAppManifest[]>();
    for (const m of manifests) {
        const key = depKey(m);
        if (!manifestsByKey.has(key)) {
            manifestsByKey.set(key, []);
        }
        manifestsByKey.get(key)!.push(m);
    }

    // For each unique package found in the cache, pick the best version:
    //   - If the package is an explicit dependency in app.json → take the
    //     highest version that is >= the declared minimum.
    //   - If the package is one of the always-included Microsoft platform
    //     packages → take the highest available version.
    //   - Otherwise skip it entirely.
    const selectedFiles: { filePath: string; manifest: AlAppManifest }[] = [];
    for (const [key, candidates] of manifestsByKey) {
        const dep = requiredDeps.get(key);
        let eligible: AlAppManifest[];
        let reason: string;

        if (dep) {
            const minVer = parseVersion(dep.version);
            eligible = candidates.filter(c => compareVersions(parseVersion(c.version), minVer) >= 0);
            if (eligible.length === 0) {
                logger.log(`No suitable package found for dependency: ${dep.publisher} - ${dep.name} >= ${dep.version}`);
                continue;
            }
            reason = `dependency >= ${dep.version}`;
        } else if (isMicrosoftPlatformPackage(candidates[0])) {
            eligible = candidates;
            reason = 'Microsoft platform package (always included)';
        } else {
            logger.debug(`Skipping unlisted package: ${candidates[0].publisher} - ${candidates[0].name}`);
            continue;
        }

        eligible.sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
        const best = eligible[0];
        logger.log(`Selected ${best.publisher} - ${best.name} ${best.version} (${reason})`);
        selectedFiles.push({ filePath: best.filePath, manifest: best });
    }

    // ── Step 3: Fully parse and load the selected .app files ────────────────
    // Keep exactly CONCURRENCY tasks in-flight at all times: as soon as one
    // finishes the next file is picked up immediately, avoiding the stall-on-
    // slowest-in-batch problem of a fixed chunked approach.
    const CONCURRENCY = 4;
    if (selectedFiles.length > 0) {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Loading packages',
                cancellable: false,
            },
            async (progress) => {
                const total = selectedFiles.length;
                let done = 0;
                let next = 0;

                progress.report({ message: `0 / ${total}`, increment: 0 });

                // Each "worker" pulls the next file from the queue until exhausted.
                const worker = async () => {
                    while (next < total) {
                        const idx = next++;
                        const { filePath, manifest } = selectedFiles[idx];
                        const pkg = await readAppFile(filePath, manifest);
                        if (pkg) {
                            store.set(pkg.id, pkg);
                            logger.debug(`Loaded package: ${pkg.publisher} - ${pkg.name} ${pkg.version} (${pkg.objects.length} objects)`);
                        }
                        done++;
                        progress.report({ message: `${done} / ${total}`, increment: (1 / total) * 100 });
                    }
                };

                await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
            }
        );
    } else {
        logger.log('No .app packages matched the dependency/platform filter.');
    }

    // ── Step 4: Parse local workspace projects as packages ─────────────────
    // Run all workspace folders in parallel – each reads its own .al files.
    const localPkgs = await Promise.all(
        folders
            .filter(folder => fs.existsSync(path.join(folder.uri.fsPath, 'app.json')))
            .map(folder => loadLocalProject(
                folder.uri.fsPath,
                path.join(folder.uri.fsPath, 'app.json')
            ))
    );
    for (const localPkg of localPkgs) {
        if (localPkg) {
            store.set(localPkg.id, localPkg);
            logger.log(`Loaded local project: ${localPkg.publisher} - ${localPkg.name} ${localPkg.version} (${localPkg.objects.length} objects)`);
        }
    }

    storeVersion++;
    vscode.window.showInformationMessage(
        `Loaded ${store.size} package(s) with ${totalObjects()} object(s).`
    );
}

// ---------------------------------------------------------------------------
// Local project parsing
// ---------------------------------------------------------------------------

/**
 * Parse all .al source files in a workspace folder and return them as an
 * AlPackage, using the project's app.json for identity metadata.
 */
async function loadLocalProject(folderPath: string, appJsonPath: string): Promise<AlPackage | undefined> {
    let publisher = 'Unknown';
    let name = path.basename(folderPath);
    let version = '0.0.0.0';
    let appId: string | undefined;

    try {
        const json = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
        publisher = json.publisher ?? publisher;
        name = json.name ?? name;
        version = json.version ?? version;
        appId = json.id;
    } catch (err) {
        logger.error(`Cannot parse ${appJsonPath}`, err);
        return undefined;
    }

    const alFiles = collectAlFiles(folderPath);
    logger.debug(`Found ${alFiles.length} local .al file(s) in ${folderPath}`);

    const objects: AlObject[] = [];
    let nextIdx = 0;

    const parseFile = async () => {
        while (nextIdx < alFiles.length) {
            const alFile = alFiles[nextIdx++];
            try {
                const source = (await fs.promises.readFile(alFile, 'utf8')).replace(/^\uFEFF/, '');
                const obj = parseAlSource(source, alFile);
                if (obj) {
                    obj.sourceFilePath = alFile;
                    objects.push(obj);
                }
            } catch (err) {
                logger.error(`Cannot read local AL file ${alFile}`, err);
            }
        }
    };

    const LOCAL_CONCURRENCY = 8;
    await Promise.all(Array.from({ length: Math.min(LOCAL_CONCURRENCY, alFiles.length) }, parseFile));

    const id = `${publisher}_${name}_${version}`.replace(/\s+/g, '_');
    return { id, publisher, name, version, filePath: appJsonPath, appId, objects };
}

// ---------------------------------------------------------------------------
// app.json dependency helpers
// ---------------------------------------------------------------------------

async function readAppJsonDependencies(appJsonPath: string): Promise<AlAppJsonDependency[]> {
    try {
        const json = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
        return Array.isArray(json.dependencies) ? json.dependencies : [];
    } catch (err) {
        logger.error(`Cannot parse ${appJsonPath}`, err);
        return [];
    }
}

/** Normalised lookup key for a dependency or manifest: "publisher|name" */
function depKey(d: { publisher: string; name: string }): string {
    return `${d.publisher.toLowerCase()}|${d.name.toLowerCase()}`;
}

/**
 * Returns true for core Microsoft platform packages that should always be
 * loaded even when not explicitly listed in app.json.
 */
const MICROSOFT_PLATFORM_PACKAGES = new Set([
    'system',
    'system application',
    'base application',
    'application',
    'business foundation'
]);

function isMicrosoftPlatformPackage(m: AlAppManifest): boolean {
    return m.publisher.toLowerCase() === 'microsoft' &&
        MICROSOFT_PLATFORM_PACKAGES.has(m.name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

type Version = [number, number, number, number];

function parseVersion(v: string): Version {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function compareVersions(a: Version, b: Version): number {
    for (let i = 0; i < 4; i++) {
        if (a[i] !== b[i]) { return a[i] - b[i]; }
    }
    return 0;
}

function compareVersionStrings(a: string, b: string): number {
    return compareVersions(parseVersion(a), parseVersion(b));
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function collectAppFiles(dir: string): string[] {
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectAppFiles(full));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.app')) {
                results.push(full);
            }
        }
    } catch (err) {
        logger.error(`Cannot read directory ${dir}`, err);
    }
    return results;
}

/** Recursively collect all .al source files, skipping hidden dirs and .alpackages. */
function collectAlFiles(dir: string): string[] {
    const SKIP_DIRS = new Set(['.alpackages', '.git', '.vs', 'node_modules', 'out', '.output']);
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectAlFiles(full));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.al')) {
                results.push(full);
            }
        }
    } catch (err) {
        logger.error(`Cannot read directory ${dir}`, err);
    }
    return results;
}

function totalObjects(): number {
    let n = 0;
    for (const pkg of store.values()) { n += pkg.objects.length; }
    return n;
}
