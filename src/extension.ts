import * as vscode from 'vscode';
import { reloadAllPackages } from './al/packageStore';
import { searchFunctionCommand, searchEventSubscriberCommand } from './al/commands';
import { getOutputChannel, log } from './al/logger';

export function activate(context: vscode.ExtensionContext): void {
	// Ensure the output channel is created and shown on first activation
	context.subscriptions.push(getOutputChannel());
	log('AL Companion activated.');

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.reloadPackages', () => {
			reloadAllPackages().catch(err => {
				vscode.window.showErrorMessage(`AL Companion: Failed to load packages — ${err}`);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.searchFunction', () => {
			searchFunctionCommand().catch(err => {
				vscode.window.showErrorMessage(`AL Companion: Search error — ${err}`);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('al-companion.searchEventSubscriber', () => {
			searchEventSubscriberCommand().catch(err => {
				vscode.window.showErrorMessage(`AL Companion: Search error — ${err}`);
			});
		})
	);
}

export function deactivate(): void {}
