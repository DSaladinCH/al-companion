import * as vscode from 'vscode';
import { AlPackage, AlEventSubscriber, AlObject } from './types';
import { getPackages } from './packageStore';
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Search Event Subscriber command
// ---------------------------------------------------------------------------

/**
 * Multi-step Quick Pick flow for finding event subscribers:
 *   1. Pick publisher object  (all distinct publishers found in loaded packages)
 *   2. Pick event name        (all distinct events for that publisher)
 *   3. Pick element (optional)(all distinct elements for that publisher+event;
 *                              skipped when every subscriber has no element)
 * Then shows matching results in a final Quick Pick.
 */
export async function searchEventSubscriberCommand(): Promise<void> {
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

    await showEventSubscriberResults(results, publisherName, eventName);
}

// ---------------------------------------------------------------------------
// Search logic
// ---------------------------------------------------------------------------

interface EventSubscriberResult {
    pkg: AlPackage;
    obj: AlObject;
    sub: AlEventSubscriber;
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

// ---------------------------------------------------------------------------
// Quick Pick display
// ---------------------------------------------------------------------------

async function showEventSubscriberResults(
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

    if (picked) {
        logger.debug(`Selected subscriber: ${picked.result.sub.fn.name}`);
        const r = picked.result;

        if (r.obj.sourceFilePath) {
            // Local workspace file – open it and jump to the subscriber function
            const uri = vscode.Uri.file(r.obj.sourceFilePath);
            const line = Math.max(0, r.sub.fn.line - 1); // convert to 0-based
            const pos = new vscode.Position(line, 0);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(pos, pos),
            });
        } else {
            // Package (.app) file – cannot open source directly
            vscode.window.showInformationMessage(
                `${r.sub.fn.name} (${r.obj.type} "${r.obj.name}") subscribes to ${r.sub.publisherObjectType} "${r.sub.publisherObjectName}".${r.sub.eventName}${r.sub.elementName ? ` [${r.sub.elementName}]` : ''} — ${r.pkg.publisher} ${r.pkg.name} ${r.pkg.version} — line ${r.sub.fn.line}`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Collect all distinct values of `getValue(sub)` from every event subscriber
 * across all packages, filtered by `predicate(sub)`.
 */
function collectDistinct(
    packages: AlPackage[],
    predicate: (sub: AlEventSubscriber) => boolean,
    getValue: (sub: AlEventSubscriber) => string
): string[] {
    const seen = new Set<string>();
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            for (const sub of obj.eventSubscribers) {
                if (predicate(sub)) {
                    seen.add(getValue(sub));
                }
            }
        }
    }
    return [...seen];
}
