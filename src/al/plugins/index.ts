/**
 * Import each plugin here to trigger its self-registration via registerPlugin().
 *
 * The registration happens at module-load time, so this file must be imported
 * once before any call to parseAlSource() — extension.ts does this at the top
 * of the file, which is evaluated before activate() is called.
 *
 * To add a new plugin:
 *   1. Create a file in this folder (e.g. myFeaturePlugin.ts).
 *   2. Implement an AlParserPlugin function and call registerPlugin() at module level.
 *   3. Optionally export a registerCommands(context) function.
 *   4. Import it below and add its registerCommands call to registerAllPluginCommands().
 */
import * as vscode from 'vscode';

import { registerCommands as registerEventSubscriberCommands } from './eventSubscriberPlugin';
import { registerCommands as registerLocalSearchCommands } from './localSearchPlugin';

/**
 * Register all VS Code commands contributed by plugins.
 * Called once from extension.ts inside activate().
 */
export function registerAllPluginCommands(context: vscode.ExtensionContext): void {
    registerEventSubscriberCommands(context);
    registerLocalSearchCommands(context);
}
