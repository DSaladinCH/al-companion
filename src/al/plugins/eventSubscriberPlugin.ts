import * as vscode from 'vscode';
import { AlObject, AlPackage, AlEventSubscriber } from '../types';
import { AlParserPlugin, registerPlugin } from '../parser';
import { getPackages } from '../packageStore';
import { findAttribute } from './parserUtils';
import * as logger from '../logger';

// ---------------------------------------------------------------------------
// EventSubscriber attribute regex
// ---------------------------------------------------------------------------

// Supported formats (second arg uses type qualifier, plain id, or quoted name):
//   [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post",  'OnBeforePost', '',    true, true)]
//   [EventSubscriber(ObjectType::Table,    Database::"Sales Header", OnAfterInsert, 'No.', false, false)]
//   [EventSubscriber(ObjectType::Codeunit, Codeunit::50100,          OnAfterMethod, '',    false, false)]
//   [EventSubscriber(ObjectType::Codeunit, 50100,                    OnAfterMethod, '',    false, false)]
//
// Groups:
//   1 – publisher object type  (e.g. "Codeunit", "Table")
//   2 – publisher name quoted  (e.g. "Sales-Post", "Sales Header")  – or undefined
//   3 – publisher name/id unquoted (e.g. "MyCodeunit", "50100")    – or undefined
//   4 – event name             (with or without surrounding single quotes)
//   5 – element name           (content of the 4th argument's single quotes, may be empty)
const EVENT_SUB_RE =
    /EventSubscriber\s*\(\s*ObjectType\s*::\s*(\w+)\s*,\s*(?:\w+\s*::\s*)?(?:"([^"]+)"|(\d+|[\w][\w.-]*)?)\s*,\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*,\s*'([^']*)'/i;

// ---------------------------------------------------------------------------
// Parser plugin
// ---------------------------------------------------------------------------

/**
 * Scans every function on the object for an `[EventSubscriber(...)]`
 * attribute and populates `obj.eventSubscribers` accordingly.
 *
 * This plugin only writes to `obj.eventSubscribers` and never modifies
 * `obj.functions` — function storage is managed by the core parser and
 * other plugins.
 */
const eventSubscriberPlugin: AlParserPlugin = (_source: string, obj: AlObject): boolean => {
    let modified = false;

    for (const fn of obj.functions) {
        const attr = findAttribute(fn, 'EventSubscriber');
        if (!attr) { continue; }

        const match = attr.match(EVENT_SUB_RE);
        if (!match) { continue; }

        obj.eventSubscribers.push({
            fn,
            publisherObjectType: match[1],
            // group 2 = double-quoted name, group 3 = unquoted name or numeric id
            publisherObjectName: (match[2] ?? match[3] ?? '').trim(),
            eventName: match[4],
            elementName: match[5],
        });
        modified = true;
    }

    return modified;
};

registerPlugin(eventSubscriberPlugin);

// ---------------------------------------------------------------------------
// Search command
// ---------------------------------------------------------------------------

interface EventSubscriberResult {
    pkg: AlPackage;
    obj: AlObject;
    sub: AlEventSubscriber;
}

async function searchEventSubscriberCommand(): Promise<void> {
    const packages = getPackages();
    if (packages.length === 0) {
        vscode.window.showWarningMessage('No packages loaded. Run "AL Companion: Reload Packages" first.');
        return;
    }

    // ── Step 1: pick publisher object ────────────────────────────────────────
    type PublisherItem = vscode.QuickPickItem & { publisherType: string; publisherName: string };

    const publisherMap = new Map<string, PublisherItem>();
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const sub of obj.eventSubscribers) {
                const key = `${sub.publisherObjectType}::${sub.publisherObjectName}`;
                if (!publisherMap.has(key)) {
                    publisherMap.set(key, {
                        label: `$(symbol-class) ${sub.publisherObjectName}`,
                        description: sub.publisherObjectType,
                        publisherType: sub.publisherObjectType,
                        publisherName: sub.publisherObjectName,
                    });
                }
            }
        }
    }

    const publisherItems = [...publisherMap.values()].sort((a, b) =>
        a.publisherName.localeCompare(b.publisherName)
    );

    if (publisherItems.length === 0) {
        vscode.window.showInformationMessage('No event subscribers found in loaded packages.');
        return;
    }

    const pickedPublisher = await vscode.window.showQuickPick(publisherItems, {
        title: 'Search Event Subscriber (1/3) — Publisher object',
        matchOnDescription: true,
        placeHolder: 'Select the object that publishes the event',
    });
    if (!pickedPublisher) { return; }

    const { publisherType, publisherName } = pickedPublisher;

    // ── Step 2: pick event name ──────────────────────────────────────────────
    const eventNames = collectDistinct(
        packages,
        sub => sub.publisherObjectType === publisherType && sub.publisherObjectName === publisherName,
        sub => sub.eventName
    );

    const eventItems: vscode.QuickPickItem[] = eventNames
        .sort()
        .map(e => ({ label: `$(symbol-event) ${e}`, description: e }));

    const pickedEvent = await vscode.window.showQuickPick(eventItems, {
        title: `Search Event Subscriber (2/3) — Event on ${publisherType} "${publisherName}"`,
        placeHolder: 'Select the event name',
    });
    if (!pickedEvent) { return; }

    const eventName = pickedEvent.description!;

    // ── Step 3: pick element (optional) ─────────────────────────────────────
    const elements = collectDistinct(
        packages,
        sub =>
            sub.publisherObjectType === publisherType &&
            sub.publisherObjectName === publisherName &&
            sub.eventName === eventName,
        sub => sub.elementName
    ).filter(e => e !== '');

    let elementFilter = '';
    if (elements.length > 0) {
        type ElementItem = vscode.QuickPickItem & { value: string };
        const anyItem: ElementItem = {
            label: '$(symbol-misc) Any element',
            description: 'No element filter',
            value: '',
        };
        const elementItems: ElementItem[] = [
            anyItem,
            ...elements.sort().map(e => ({ label: `$(symbol-field) ${e}`, description: e, value: e })),
        ];

        const pickedElement = await vscode.window.showQuickPick(elementItems, {
            title: `Search Event Subscriber (3/3) — Element filter for ${eventName}`,
            placeHolder: 'Select a field / action, or "Any element" to skip',
        });
        if (!pickedElement) { return; }
        elementFilter = (pickedElement as ElementItem).value;
    }

    // ── Run search & show results ────────────────────────────────────────────
    const results = searchEventSubscribers(packages, publisherType, publisherName, eventName, elementFilter);
    logger.debug(`Event subscriber search "${publisherType}::${publisherName}.${eventName}" → ${results.length} result(s)`);

    if (results.length === 0) {
        vscode.window.showInformationMessage(
            `No event subscribers found for "${publisherType} ${publisherName} → ${eventName}".`
        );
        return;
    }

    await showResults(results, publisherName, eventName);
}

function searchEventSubscribers(
    packages: AlPackage[],
    publisherType: string,
    publisherName: string,
    eventName: string,
    element: string
): EventSubscriberResult[] {
    const results: EventSubscriberResult[] = [];
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const sub of obj.eventSubscribers) {
                if (sub.publisherObjectType !== publisherType) { continue; }
                if (sub.publisherObjectName !== publisherName) { continue; }
                if (sub.eventName !== eventName) { continue; }
                if (element && sub.elementName !== element) { continue; }
                results.push({ pkg, obj, sub });
            }
        }
    }
    return results;
}

async function showResults(
    results: EventSubscriberResult[],
    publisherName: string,
    eventName: string
): Promise<void> {
    type Item = vscode.QuickPickItem & { result: EventSubscriberResult };

    const items: Item[] = results.map(r => ({
        label: `$(symbol-function) ${r.sub.fn.name}`,
        description: `${r.obj.type} ${r.obj.id} "${r.obj.name}"${r.sub.elementName ? `  ·  [${r.sub.elementName}]` : ''}`,
        detail: `${r.pkg.publisher} – ${r.pkg.name} ${r.pkg.version}  ·  line ${r.sub.fn.line}`,
        result: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Subscribers of "${publisherName} → ${eventName}" (${results.length})`,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked) { return; }

    logger.debug(`Selected subscriber: ${picked.result.sub.fn.name}`);
    const r = picked.result;

    if (r.obj.sourceFilePath) {
        const uri = vscode.Uri.file(r.obj.sourceFilePath);
        const pos = new vscode.Position(Math.max(0, r.sub.fn.line - 1), 0);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    } else if (r.obj.zipEntryName) {
        const uri = vscode.Uri.from({
            scheme: 'al-companion-app',
            path: '/' + r.obj.zipEntryName,
            query: 'path=' + encodeURIComponent(r.pkg.filePath),
        });
        const pos = new vscode.Position(Math.max(0, r.sub.fn.line - 1), 0);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    } else {
        vscode.window.showInformationMessage(
            `${r.sub.fn.name} (${r.obj.type} "${r.obj.name}") — ${r.pkg.publisher} ${r.pkg.name} ${r.pkg.version} — line ${r.sub.fn.line}`
        );
    }
}

function collectDistinct(
    packages: AlPackage[],
    predicate: (sub: AlEventSubscriber) => boolean,
    getValue: (sub: AlEventSubscriber) => string
): string[] {
    const seen = new Set<string>();
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const sub of obj.eventSubscribers) {
                if (predicate(sub)) { seen.add(getValue(sub)); }
            }
        }
    }
    return [...seen];
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('al-companion.searchEventSubscriber', () => {
            searchEventSubscriberCommand().catch(err => {
                vscode.window.showErrorMessage(`Search error — ${err}`);
            });
        })
    );
}
