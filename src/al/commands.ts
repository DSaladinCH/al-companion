import * as vscode from 'vscode';
import { AlPackage, AlObject } from './types';

// ---------------------------------------------------------------------------
// Centralized file opening utility
// ---------------------------------------------------------------------------

/**
 * Open an AL object in the VS Code editor, optionally positioning the cursor
 * at a specific line and column.
 *
 * Handles three cases:
 * 1. Local `.al` file (sourceFilePath) — opens as a regular editable document
 * 2. Package `.app` ZIP entry (zipEntryName) — serves via virtual provider, opens in preview mode
 * 3. Neither available — shows an info message with object coordinates
 *
 * @param obj The AL object to open
 * @param pkg The package containing the object
 * @param line Optional line number (1-based); defaults to object declaration line
 * @param column Optional column number (0-based); defaults to 0
 */
export async function showAlObject(
    obj: AlObject,
    pkg: AlPackage,
    line?: number,
    column?: number
): Promise<void> {
    const targetLine = line ?? obj.line;
    const targetColumn = column ?? 0;
    const pos = new vscode.Position(Math.max(0, targetLine - 1), Math.max(0, targetColumn));

    if (obj.sourceFilePath) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(obj.sourceFilePath));
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    } else if (obj.zipEntryName) {
        const uri = vscode.Uri.from({
            scheme: 'al-companion-app',
            path: '/' + obj.zipEntryName,
            query: 'path=' + encodeURIComponent(pkg.filePath),
        });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    } else {
        vscode.window.showInformationMessage(
            `${obj.type} "${obj.name}" — ${pkg.publisher} ${pkg.name} ${pkg.version} — line ${targetLine}`
        );
    }
}

/**
 * Alternative approach: Open an AL object using the al-preview://allang/ URI scheme.
 * This method works for both local and package files.
 *
 * Handles two cases:
 * 1. Local `.al` file (sourceFilePath) — opens as a regular editable document
 * 2. Package `.app` file — creates a URI like: al-preview://allang/{appId}/{objectType}/{objectId}/{objectName}.dal
 *    Uses the real app GUID if available (pkg.appId), otherwise falls back to package name.
 *
 * @param obj The AL object to open
 * @param pkg The package containing the object
 * @param line Optional line number (1-based); defaults to object declaration line
 * @param column Optional column number (0-based); defaults to 0
 */
export async function showAlObjectUsingPreviewScheme(
    obj: AlObject,
    pkg: AlPackage,
    line?: number,
    column?: number
): Promise<void> {
    const targetLine = line ?? obj.line;
    const targetColumn = column ?? 0;
    const pos = new vscode.Position(Math.max(0, targetLine - 1), Math.max(0, targetColumn));

    if (obj.sourceFilePath) {
        // Local file: open normally as editable document
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(obj.sourceFilePath));
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    } else {
        // Package file: use al-preview://allang/ scheme
        // Prefer real app GUID (appId), fall back to package name, sanitize to remove non-word chars
        const safeAppId = (pkg.appId ?? pkg.name).replace(/\W/g, '');
        const safeObjectId = obj.id === 0 ? '-1' : obj.id.toString();
        console.log(obj.zipEntryName);

        let doc: vscode.TextDocument;
        try {
            // First attempt: use sanitized object name
            const safeObjectName = obj.name.replace(/\W/g, '');
            const uri = vscode.Uri.parse(
                `al-preview://allang/${safeAppId}/${obj.type}/${safeObjectId}/${safeObjectName}.dal`
            );
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            // Fallback: use raw object name
            const uri = vscode.Uri.parse(
                `al-preview://allang/${safeAppId}/${obj.type}/${safeObjectId}/${obj.name}.dal`
            );
            doc = await vscode.workspace.openTextDocument(uri);
        }
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    }
}

// ---------------------------------------------------------------------------
// Note: Command implementations have been moved to plugins
// ---------------------------------------------------------------------------
// This file now contains only shared utility functions like showAlObject and showAlObjectUsingPreviewScheme.
// Specific command logic resides in the corresponding plugin files:
// - eventSubscriberPlugin.ts: searchEventSubscriber command
// - navigateToObjectPlugin.ts: navigateToReferencedObject command
// - localSearchPlugin.ts: searchLocalFiles command
// - jumpToFunctionLinePlugin.ts: jumpToFunctionLine command
