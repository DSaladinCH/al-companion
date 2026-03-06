import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { reloadAllPackages } from './al/packageStore';
import { searchEventSubscriberCommand } from './al/commands';
import { getOutputChannel, log } from './al/logger';

export function activate(context: vscode.ExtensionContext): void {
	// Ensure the output channel is created and shown on first activation
	context.subscriptions.push(getOutputChannel());
	log('AL Companion activated.');

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.reloadPackages', () => {
			reloadAllPackages().catch(err => {
				vscode.window.showErrorMessage(`Failed to load packages — ${err}`);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.searchEventSubscriber', () => {
			searchEventSubscriberCommand().catch(err => {
				vscode.window.showErrorMessage(`Search error — ${err}`);
			});
		})
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
