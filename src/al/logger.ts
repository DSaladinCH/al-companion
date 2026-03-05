import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('AL Companion');
    }
    return outputChannel;
}

export function log(message: string): void {
    getOutputChannel().appendLine(`[${timestamp()}] ${message}`);
}

export function debug(message: string): void {
    const cfg = vscode.workspace.getConfiguration('al-companion');
    if (cfg.get<boolean>('debugLogging', false)) {
        getOutputChannel().appendLine(`[${timestamp()}] [DEBUG] ${message}`);
    }
}

export function error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : err !== undefined ? ` — ${String(err)}` : '';
    getOutputChannel().appendLine(`[${timestamp()}] [ERROR] ${message}${detail}`);
}

function timestamp(): string {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
