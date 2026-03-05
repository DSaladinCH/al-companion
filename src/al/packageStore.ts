import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AlPackage } from './types';
import { readAppFile } from './packageReader';
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

// ---------------------------------------------------------------------------
// Discovery & loading
// ---------------------------------------------------------------------------

/**
 * Scan all open workspace folders for AL projects and load their dependency
 * packages from the .alpackages directories.
 *
 * Skips workspace folders that do not contain an app.json (i.e. are not AL
 * projects).  Non-existent .alpackages directories are silently ignored so
 * that partial / non-AL workspaces don't produce errors.
 */
export async function reloadAllPackages(): Promise<void> {
    store.clear();

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        logger.log('No workspace folders open.');
        return;
    }

    // Collect .app file paths from every AL project workspace folder
    const appFiles: string[] = [];
    for (const folder of folders) {
        const folderPath = folder.uri.fsPath;
        const appJsonPath = path.join(folderPath, 'app.json');
        if (!fs.existsSync(appJsonPath)) {
            logger.debug(`Skipping non-AL folder: ${folderPath}`);
            continue;
        }

        const packageDir = path.join(folderPath, '.alpackages');
        if (!fs.existsSync(packageDir)) {
            logger.debug(`No .alpackages directory in ${folderPath}`);
            continue;
        }

        const found = collectAppFiles(packageDir);
        logger.log(`Found ${found.length} package(s) in ${packageDir}`);
        appFiles.push(...found);
    }

    if (appFiles.length === 0) {
        logger.log('No .app packages found in any AL workspace folder.');
        vscode.window.showInformationMessage('AL Companion: No packages found.');
        return;
    }

    // Parse with a progress notification
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'AL Companion: Loading packages',
            cancellable: false,
        },
        async (progress) => {
            const total = appFiles.length;
            let done = 0;

            for (const appFile of appFiles) {
                const label = path.basename(appFile);
                progress.report({
                    message: label,
                    increment: 0,
                });

                const pkg = await readAppFile(appFile);
                if (pkg) {
                    store.set(pkg.id, pkg);
                    logger.debug(`Loaded package: ${pkg.publisher} - ${pkg.name} ${pkg.version} (${pkg.objects.length} objects)`);
                }

                done++;
                progress.report({
                    message: label,
                    increment: (1 / total) * 100,
                });
            }

            logger.log(`Loaded ${store.size} package(s) with ${totalObjects()} object(s).`);
        }
    );

    vscode.window.showInformationMessage(
        `AL Companion: Loaded ${store.size} package(s).`
    );
}

// ---------------------------------------------------------------------------
// Helpers
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

function totalObjects(): number {
    let n = 0;
    for (const pkg of store.values()) { n += pkg.objects.length; }
    return n;
}
