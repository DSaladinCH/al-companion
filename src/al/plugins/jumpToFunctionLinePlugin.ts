import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Procedure / trigger detection (mirrors the core parser regex structure)
// ---------------------------------------------------------------------------

const PROCEDURE_RE =
    /^\s*(local\s+|internal\s+)*(procedure|trigger)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/**
 * Prompts the user for a relative line number and jumps to that line within
 * the function the cursor is currently inside.
 *
 * Counting starts at the line immediately after the function declaration line
 * (the line with "procedure" / "trigger").  All lines count: "var", variable
 * declarations, "begin", code lines, empty lines, and "end;".
 */
async function jumpToFunctionLine(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('AL Companion: No active editor.');
        return;
    }

    const document = editor.document;
    const cursorLine = editor.selection.active.line; // 0-based

    // Scan backwards from the cursor to find the nearest function declaration.
    let functionLine = -1;
    let functionName = '';
    for (let i = cursorLine; i >= 0; i--) {
        const m = document.lineAt(i).text.match(PROCEDURE_RE);
        if (m) {
            functionLine = i;
            functionName = m[3];
            break;
        }
    }

    if (functionLine < 0) {
        vscode.window.showErrorMessage('AL Companion: Cursor is not inside a function.');
        return;
    }

    const input = await vscode.window.showInputBox({
        title: `Jump to Function Line — ${functionName}`,
        prompt: `Function is declared at line ${functionLine + 1}. Line 1 starts at line ${functionLine + 2}.`,
        placeHolder: 'Line number',
        validateInput: (value) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n < 1) {
                return 'Please enter a positive integer.';
            }
            return null;
        },
    });

    if (input === undefined) {
        return; // user cancelled
    }

    const lineNumber = parseInt(input, 10);
    // functionLine is 0-based; the function declaration is "line 0" in the
    // user's counting, so relative line 1 maps to functionLine + 1, etc.
    const targetLine = functionLine + lineNumber; // 0-based

    if (targetLine >= document.lineCount) {
        vscode.window.showErrorMessage(
            `AL Companion: Line ${lineNumber} is beyond the end of the file.`
        );
        return;
    }

    const targetPosition = new vscode.Position(targetLine, 0);
    editor.selection = new vscode.Selection(targetPosition, targetPosition);
    editor.revealRange(
        new vscode.Range(targetPosition, targetPosition),
        vscode.TextEditorRevealType.InCenter
    );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('al-companion.jumpToFunctionLine', jumpToFunctionLine)
    );
}
