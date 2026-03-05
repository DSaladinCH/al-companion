import * as vscode from 'vscode';
import { AlPackage, AlFunction, AlObject, AlEventSubscriber } from './types';
import { getPackages } from './packageStore';
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Search Function command
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a function name and optionally limit the search to
 * specific packages, then show results in a Quick Pick.
 */
export async function searchFunctionCommand(): Promise<void> {
    const packages = getPackages();
    if (packages.length === 0) {
        vscode.window.showWarningMessage('AL Companion: No packages loaded. Run "AL Companion: Reload Packages" first.');
        return;
    }

    // Step 1 – select packages (all or a subset)
    const selectedPackages = await pickPackages(packages);
    if (!selectedPackages) { return; } // user cancelled

    // Step 2 – enter function name to search
    const query = await vscode.window.showInputBox({
        title: 'Search AL Function',
        prompt: 'Enter function name (or part of it)',
        placeHolder: 'e.g. OnBeforePost',
    });
    if (query === undefined) { return; }

    const results = searchFunctions(selectedPackages, query.trim());
    logger.debug(`Function search "${query}" → ${results.length} result(s)`);

    if (results.length === 0) {
        vscode.window.showInformationMessage(`AL Companion: No functions matching "${query}" found.`);
        return;
    }

    await showFunctionResults(results, query);
}

// ---------------------------------------------------------------------------
// Search Event Subscriber command
// ---------------------------------------------------------------------------

/**
 * Prompt the user for an event name and optionally a publisher object name
 * and element, then show matching event-subscriber functions.
 */
export async function searchEventSubscriberCommand(): Promise<void> {
    const packages = getPackages();
    if (packages.length === 0) {
        vscode.window.showWarningMessage('AL Companion: No packages loaded. Run "AL Companion: Reload Packages" first.');
        return;
    }

    // Step 1 – event name
    const eventName = await vscode.window.showInputBox({
        title: 'Search Event Subscriber (1/3)',
        prompt: 'Enter event name (or part of it)',
        placeHolder: 'e.g. OnBeforePost',
    });
    if (eventName === undefined) { return; }

    // Step 2 – optional publisher object name
    const publisherObject = await vscode.window.showInputBox({
        title: 'Search Event Subscriber (2/3)',
        prompt: 'Publisher object name (leave blank to search all)',
        placeHolder: 'e.g. Sales Header  (optional)',
    });
    if (publisherObject === undefined) { return; }

    // Step 3 – optional element (field/action) – only prompted when an object was entered
    let element = '';
    if (publisherObject.trim() !== '') {
        const el = await vscode.window.showInputBox({
            title: 'Search Event Subscriber (3/3)',
            prompt: 'Field / action name within the object (leave blank to skip)',
            placeHolder: 'e.g. No.  (optional)',
        });
        if (el === undefined) { return; }
        element = el.trim();
    }

    const results = searchEventSubscribers(packages, eventName.trim(), publisherObject.trim(), element);
    logger.debug(`Event subscriber search "${eventName}" → ${results.length} result(s)`);

    if (results.length === 0) {
        vscode.window.showInformationMessage(`AL Companion: No event subscribers matching "${eventName}" found.`);
        return;
    }

    await showEventSubscriberResults(results, eventName);
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

interface FunctionResult {
    pkg: AlPackage;
    obj: AlObject;
    fn: AlFunction;
}

interface EventSubscriberResult {
    pkg: AlPackage;
    obj: AlObject;
    sub: AlEventSubscriber;
}

function searchFunctions(packages: AlPackage[], query: string): FunctionResult[] {
    const q = query.toLowerCase();
    const results: FunctionResult[] = [];
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const fn of obj.functions) {
                if (fn.name.toLowerCase().includes(q)) {
                    results.push({ pkg, obj, fn });
                }
            }
        }
    }
    return results;
}

function searchEventSubscribers(
    packages: AlPackage[],
    eventName: string,
    publisherObject: string,
    element: string
): EventSubscriberResult[] {
    const evQ = eventName.toLowerCase();
    const objQ = publisherObject.toLowerCase();
    const elQ = element.toLowerCase();

    const results: EventSubscriberResult[] = [];
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const sub of obj.eventSubscribers) {
                if (!sub.eventName.toLowerCase().includes(evQ)) { continue; }
                if (objQ && !sub.publisherObjectName.toLowerCase().includes(objQ)) { continue; }
                if (elQ && !sub.elementName.toLowerCase().includes(elQ)) { continue; }
                results.push({ pkg, obj, sub });
            }
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Quick Pick display
// ---------------------------------------------------------------------------

async function showFunctionResults(results: FunctionResult[], query: string): Promise<void> {
    type Item = vscode.QuickPickItem & { result: FunctionResult };

    const items: Item[] = results.map(r => ({
        label: `$(symbol-function) ${r.fn.name}`,
        description: `${r.obj.type} ${r.obj.id} "${r.obj.name}"`,
        detail: `${r.pkg.publisher} – ${r.pkg.name} ${r.pkg.version}  ·  line ${r.fn.line}`,
        result: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Function search results for "${query}" (${results.length})`,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (picked) {
        logger.debug(`Selected function: ${picked.result.fn.name} in ${picked.result.pkg.name}`);
        vscode.window.showInformationMessage(
            `${picked.result.fn.name} — ${picked.result.obj.type} "${picked.result.obj.name}" — ${picked.result.pkg.publisher} ${picked.result.pkg.name} ${picked.result.pkg.version} — line ${picked.result.fn.line}`
        );
    }
}

async function showEventSubscriberResults(results: EventSubscriberResult[], query: string): Promise<void> {
    type Item = vscode.QuickPickItem & { result: EventSubscriberResult };

    const items: Item[] = results.map(r => ({
        label: `$(symbol-event) ${r.sub.fn.name}`,
        description: `${r.obj.type} ${r.obj.id} "${r.obj.name}"  ·  subscribes ${r.sub.publisherObjectType}::"${r.sub.publisherObjectName}".${r.sub.eventName}${r.sub.elementName ? ` [${r.sub.elementName}]` : ''}`,
        detail: `${r.pkg.publisher} – ${r.pkg.name} ${r.pkg.version}  ·  line ${r.sub.fn.line}`,
        result: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Event subscriber results for "${query}" (${results.length})`,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (picked) {
        logger.debug(`Selected subscriber: ${picked.result.sub.fn.name}`);
        const r = picked.result;
        vscode.window.showInformationMessage(
            `${r.sub.fn.name} (${r.obj.type} "${r.obj.name}") subscribes to ${r.sub.publisherObjectType} "${r.sub.publisherObjectName}" . ${r.sub.eventName}${r.sub.elementName ? ` [${r.sub.elementName}]` : ''} — ${r.pkg.publisher} ${r.pkg.name} ${r.pkg.version} — line ${r.sub.fn.line}`
        );
    }
}

// ---------------------------------------------------------------------------
// Package picker helper
// ---------------------------------------------------------------------------

/**
 * Show a multi-select quick pick listing all loaded packages.
 * Returns the selected packages, or all packages when the user picks "All".
 * Returns undefined when the user cancels.
 */
async function pickPackages(packages: AlPackage[]): Promise<AlPackage[] | undefined> {
    type Item = vscode.QuickPickItem & { pkgs: AlPackage[] };

    const allItem: Item = {
        label: '$(package) All packages',
        description: `${packages.length} package(s)`,
        pkgs: packages,
        picked: true,
    };

    const pkgItems: Item[] = packages.map(p => ({
        label: `$(package) ${p.name}`,
        description: `${p.publisher}  v${p.version}`,
        detail: p.filePath,
        pkgs: [p],
        picked: false,
    }));

    const allItems: Item[] = [allItem, ...pkgItems];

    const picked = await vscode.window.showQuickPick(allItems, {
        title: 'Select packages to search',
        canPickMany: true,
        matchOnDescription: true,
    });

    if (!picked || picked.length === 0) { return undefined; }

    // If "All packages" was selected, return everything
    if (picked.some(i => i.pkgs === packages)) { return packages; }

    return picked.flatMap(i => i.pkgs);
}
