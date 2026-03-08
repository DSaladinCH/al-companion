import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { reloadAllPackages, reloadLocalFile } from './al/packageStore';
import { getOutputChannel, log } from './al/logger';
import { readAlFileFromPackage } from './al/packageReader';
import { registerAllPluginCommands } from './al/plugins';

// ---------------------------------------------------------------------------
// Virtual document provider for .al files inside .app packages
// ---------------------------------------------------------------------------

/**
 * Serves read-only AL source content extracted on-demand from a .app ZIP.
 *
 * URI format:  al-companion-app:/<zipEntryName>?path=<encodeURIComponent(appFilePath)>
 *
 * The URI path (minus the leading "/") is the entry name inside the ZIP.
 * VS Code derives the tab title from the last path segment (the .al filename)
 * and picks up the AL language via the ".al" extension.
 */
class AlAppContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const pkgPath = new URLSearchParams(uri.query).get('path');
        if (!pkgPath) { return ''; }
        const entryName = uri.path.slice(1); // strip leading '/'
        return (await readAlFileFromPackage(pkgPath, entryName)) ?? '';
    }
}

export function activate(context: vscode.ExtensionContext): void {
	// Ensure the output channel is created and shown on first activation
	context.subscriptions.push(getOutputChannel());
	log('AL Companion activated.');

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider('al-companion-app', new AlAppContentProvider())
	);

	registerAllPluginCommands(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.reloadPackages', () => {
			reloadAllPackages().catch(err => {
				vscode.window.showErrorMessage(`Failed to load packages — ${err}`);
			});
		})
	);

	// Watch local .al files and keep their symbols up-to-date incrementally.
	const alWatcher = vscode.workspace.createFileSystemWatcher('**/*.al');
	const onAlFileEvent = (uri: vscode.Uri) => {
		reloadLocalFile(uri.fsPath).catch(err => {
			vscode.window.showErrorMessage(`Failed to update ${path.basename(uri.fsPath)} — ${err}`);
		});
	};
	context.subscriptions.push(
		alWatcher,
		alWatcher.onDidChange(onAlFileEvent),
		alWatcher.onDidCreate(onAlFileEvent),
		alWatcher.onDidDelete(onAlFileEvent),
	);

	// Auto-load packages if at least one AL project is open
	const hasAlProject = (vscode.workspace.workspaceFolders ?? []).some(f =>
		fs.existsSync(path.join(f.uri.fsPath, 'app.json'))
	);

	if (hasAlProject) {
		reloadAllPackages().catch(err => {
			vscode.window.showErrorMessage(`Failed to load packages — ${err}`);
		});
	}
}

export function deactivate(): void {}
