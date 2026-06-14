import * as vscode from 'vscode';
import { AlObject, AlPackage, AlEventSubscriber } from '../types';
import { AlParserPlugin, registerPlugin } from '../parser';
import { getPackages, getStoreVersion } from '../packageStore';
import { registerObjectProcessor, ObjectProcessor } from '../objectProcessor';
import { findAttribute, parseAttributeArgs, unquote } from './parserUtils';
import { showAlObjectUsingPreviewScheme } from '../commands';
import * as logger from '../logger';

// ---------------------------------------------------------------------------
// Parser plugin
// ---------------------------------------------------------------------------

// Quick guard to extract the publisher object type before delegating argument
// parsing to parseAttributeArgs (which handles all quote styles).
const EVENT_SUB_TYPE_RE = /^EventSubscriber\s*\(\s*ObjectType\s*::\s*(\w+)/i;

/**
 * Scans every function on the object for an `[EventSubscriber(...)]`
 * attribute and populates `obj.eventSubscribers` accordingly.
 *
 * Uses `parseAttributeArgs` + `unquote` so that element names with double
 * quotes (e.g. `"RIB M13 Customer Template Code"`), single quotes, or no
 * quotes at all are all captured correctly.
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

        const typeMatch = attr.match(EVENT_SUB_TYPE_RE);
        if (!typeMatch) { continue; }

        const args = parseAttributeArgs(attr);
        if (args.length < 3) { continue; }

        // arg[0] = ObjectType::Table
        const publisherObjectType = typeMatch[1];

        // arg[1] = Database::"Sales Header"  |  Codeunit::MyCU  |  50100
        const publisherObjectName = unquote(args[1].trim().replace(/^\w+\s*::\s*/, ''));

        // arg[2] = OnAfterValidateEvent  |  'OnBeforePost'
        const eventName = unquote(args[2]);

        // arg[3] = "RIB M13 Customer Template Code"  |  'No.'  |  MyField  |  ''  |  absent
        const elementName = args.length >= 4 ? unquote(args[3]) : '';

        obj.eventSubscribers.push({
            fn,
            publisherObjectType,
            publisherObjectName,
            eventName,
            elementName,
        });
        modified = true;
    }

    return modified;
};

registerPlugin(eventSubscriberPlugin);

// ---------------------------------------------------------------------------
// Event subscriber indexing (single-pass during package load)
// ---------------------------------------------------------------------------

/**
 * Wrapper for a subscriber that includes its owning object and package.
 * Stored in the index to avoid needing to search for the owner later.
 */
interface IndexedSubscriber {
    sub: AlEventSubscriber;
    obj: AlObject;
    pkg: AlPackage;
}

/**
 * Index structure built during reloadAllPackages() in a single pass.
 * Avoids O(n³) search time by pre-grouping subscribers by their keys.
 * Each indexed subscriber includes references to its owning object and package.
 *
 * Three indexes are built:
 * - byPublisher: "Type::Name" → indexed subscribers on that object
 * - byEvent: "Type::Name::EventName" → indexed subscribers of that event
 * - byElement: "Type::Name::EventName::Element" → indexed subscribers filtering by element
 */
interface EventSubscriberIndex {
    byPublisher: Map<string, IndexedSubscriber[]>;
    byEvent: Map<string, IndexedSubscriber[]>;
    byElement: Map<string, IndexedSubscriber[]>;
}

let eventSubscriberIndex: EventSubscriberIndex = {
    byPublisher: new Map(),
    byEvent: new Map(),
    byElement: new Map(),
};
let eventSubscriberIndexVersion = -1;

/**
 * Processor that builds the event subscriber index.
 * This runs once per object during reloadAllPackages() in a single pass.
 */
const eventSubscriberIndexer: ObjectProcessor = {
    id: 'event-subscriber-indexer',
    process(obj: AlObject, pkg: AlPackage): void {
        for (const sub of obj.eventSubscribers) {
            const publisherKey = `${sub.publisherObjectType}::${sub.publisherObjectName}`;
            const eventKey = `${publisherKey}::${sub.eventName}`;
            const elementKey = `${eventKey}::${sub.elementName}`;
            const indexed: IndexedSubscriber = { sub, obj, pkg };

            // Index by publisher
            if (!eventSubscriberIndex.byPublisher.has(publisherKey)) {
                eventSubscriberIndex.byPublisher.set(publisherKey, []);
            }
            eventSubscriberIndex.byPublisher.get(publisherKey)!.push(indexed);

            // Index by event
            if (!eventSubscriberIndex.byEvent.has(eventKey)) {
                eventSubscriberIndex.byEvent.set(eventKey, []);
            }
            eventSubscriberIndex.byEvent.get(eventKey)!.push(indexed);

            // Index by element (if element specified)
            if (sub.elementName) {
                if (!eventSubscriberIndex.byElement.has(elementKey)) {
                    eventSubscriberIndex.byElement.set(elementKey, []);
                }
                eventSubscriberIndex.byElement.get(elementKey)!.push(indexed);
            }
        }
    },
};

registerObjectProcessor(eventSubscriberIndexer);

/**
 * Reset the index before a new reload starts.
 * Called from packageStore before processAllObjects.
 */
export function resetEventSubscriberIndex(): void {
    eventSubscriberIndex = {
        byPublisher: new Map(),
        byEvent: new Map(),
        byElement: new Map(),
    };
}

/**
 * Mark the index as complete after a successful reload.
 * Called from packageStore after processAllObjects.
 */
export function markEventSubscriberIndexReady(version: number): void {
    eventSubscriberIndexVersion = version;
}

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

    // Ensure index is up-to-date
    const currentVersion = getStoreVersion();
    if (eventSubscriberIndexVersion !== currentVersion) {
        // Index is stale; it will be rebuilt on next reloadAllPackages()
        vscode.window.showWarningMessage('Symbol index is being rebuilt. Please try again.');
        return;
    }

    // ── Step 1: pick publisher object (O(1) from index) ──────────────────────
    type PublisherItem = vscode.QuickPickItem & { publisherType: string; publisherName: string };

    const publisherMap = new Map<string, PublisherItem>();
    for (const [publisherKey, indexed] of eventSubscriberIndex.byPublisher) {
        if (indexed.length === 0) { continue; }
        const first = indexed[0];
        publisherMap.set(publisherKey, {
            label: `$(symbol-class) ${first.sub.publisherObjectName}`,
            description: first.sub.publisherObjectType,
            publisherType: first.sub.publisherObjectType,
            publisherName: first.sub.publisherObjectName,
        });
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
    const publisherKey = `${publisherType}::${publisherName}`;

    // ── Step 2: pick event name (O(1) from index) ────────────────────────────
    const indexed = eventSubscriberIndex.byPublisher.get(publisherKey) ?? [];
    const eventNames = [...new Set(indexed.map(i => i.sub.eventName))].sort();

    const eventItems: vscode.QuickPickItem[] = eventNames
        .map(e => ({ label: `$(symbol-event) ${e}`, description: e }));

    const pickedEvent = await vscode.window.showQuickPick(eventItems, {
        title: `Search Event Subscriber (2/3) — Event on ${publisherType} "${publisherName}"`,
        placeHolder: 'Select the event name',
    });
    if (!pickedEvent) { return; }

    const eventName = pickedEvent.description!;
    const eventKey = `${publisherKey}::${eventName}`;

    // ── Step 3: pick element (optional, O(1) from index) ────────────────────
    const eventIndexed = eventSubscriberIndex.byEvent.get(eventKey) ?? [];
    const elements = [...new Set(eventIndexed.map(i => i.sub.elementName).filter(e => e !== ''))].sort();

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
            ...elements.map(e => ({ label: `$(symbol-field) ${e}`, description: e, value: e })),
        ];

        const pickedElement = await vscode.window.showQuickPick(elementItems, {
            title: `Search Event Subscriber (3/3) — Element filter for ${eventName}`,
            placeHolder: 'Select a field / action, or "Any element" to skip',
        });
        if (!pickedElement) { return; }
        elementFilter = (pickedElement as ElementItem).value;
    }

    // ── Run search & show results (O(n) where n = matching subscribers) ──────
    const results = searchEventSubscribersFromIndex(packages, eventKey, elementFilter);
    logger.debug(`Event subscriber search "${publisherType}::${publisherName}.${eventName}" → ${results.length} result(s)`);

    if (results.length === 0) {
        vscode.window.showInformationMessage(
            `No event subscribers found for "${publisherType} ${publisherName} → ${eventName}".`
        );
        return;
    }

    await showResults(results, publisherName, eventName);
}

/**
 * Search for event subscribers using the pre-built index.
 * O(n) where n = matching subscribers, no nested loops needed.
 * Package/object references are already stored in the index.
 */
function searchEventSubscribersFromIndex(
    packages: AlPackage[],
    eventKey: string,
    elementFilter: string
): EventSubscriberResult[] {
    const results: EventSubscriberResult[] = [];
    const indexed = eventSubscriberIndex.byEvent.get(eventKey) ?? [];

    // Filter by element if specified; extract sub/obj/pkg directly from index
    for (const item of indexed) {
        if (!elementFilter || item.sub.elementName === elementFilter) {
            results.push({ pkg: item.pkg, obj: item.obj, sub: item.sub });
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

    await showAlObjectUsingPreviewScheme(r.obj, r.pkg, r.sub.fn.line);
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
