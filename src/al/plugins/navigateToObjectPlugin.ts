import * as vscode from 'vscode';
import { AlObject, AlObjectType, AlPackage } from '../types';
import { AlParserPlugin, registerPlugin } from '../parser';
import { getPackages } from '../packageStore';
import { showAlObjectUsingPreviewScheme } from '../commands';
import * as logger from '../logger';


// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

// namespace MyCompany.MyModule;
const NAMESPACE_RE = /^\s*namespace\s+([\w.]+)\s*;/m;

// using MyCompany.MyModule;
const USING_RE = /^\s*using\s+([\w.]+)\s*;/gm;

// SourceTable = "Sales Header";  or  SourceTable = Customer;
const SOURCE_TABLE_RE = /^\s*SourceTable\s*=\s*"?([^";\/\r\n]+?)"?\s*;/im;

// ---------------------------------------------------------------------------
// Parser plugin
// ---------------------------------------------------------------------------

/**
 * Extracts namespace, using directives, and (for Page objects) the SourceTable
 * property from the raw source and stores them on the AlObject so the
 * navigation command can resolve object references at runtime.
 *
 * The following fields are populated when present in the source:
 * - `obj.namespace`  — the `namespace` statement at the top of the file.
 * - `obj.usings`     — all `using` directives, in declaration order.
 * - `obj.sourceTable`— the `SourceTable` property (Page objects only).
 *
 * This plugin never modifies obj.functions or obj.elements.
 */
const navigateToObjectPlugin: AlParserPlugin = (source: string, obj: AlObject): boolean => {
    let modified = false;

    const nsMatch = source.match(NAMESPACE_RE);
    if (nsMatch) {
        obj.namespace = nsMatch[1];
        modified = true;
    }

    USING_RE.lastIndex = 0;
    const usings: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = USING_RE.exec(source)) !== null) {
        usings.push(m[1]);
    }
    if (usings.length > 0) {
        obj.usings = usings;
        modified = true;
    }

    // SourceTable is only a property of Page objects
    if (obj.type === 'Page') {
        const stMatch = source.match(SOURCE_TABLE_RE);
        if (stMatch) {
            obj.sourceTable = stMatch[1].trim();
            modified = true;
        }
    }

    return modified;
};

registerPlugin(navigateToObjectPlugin);

// ---------------------------------------------------------------------------
// Extensible reference-property registry
// ---------------------------------------------------------------------------

/**
 * Describes a single navigatable reference found on an AL object.
 *
 * Each property produces one entry in the navigation picker when the
 * command is invoked.  The `label` should include a codicon prefix for
 * visual clarity; `description` appears in the secondary column.
 *
 * New reference types (e.g. `LookupPageId`, `DrillDownPageId`) can be
 * supported by calling `registerReferenceCollector()` at module level.
 */
export interface ReferenceProperty {
    /**
     * Display text including a leading codicon, shown as the picker label.
     * Example: `"$(type-hierarchy-sub) Extends Page: \"Customer Card\""`.
     */
    label: string;
    /**
     * Secondary text shown to the right of the label in the picker.
     * Typically the AL object type, e.g. `"Page"` or `"Table (via Customer Card)"`.
     */
    description: string;
    /** The raw reference name as written in AL source (may contain a namespace prefix or quotes). */
    refName: string;
    /** AL object type(s) accepted as the target of this reference. */
    targetTypes: AlObjectType[];
}

/**
 * A collector receives the current AlObject and all loaded packages and
 * returns zero or more navigatable references found on that object.
 *
 * Collectors run at command invocation time and may perform cross-object
 * lookups (e.g. reading the base page's SourceTable for a PageExtension).
 *
 * Register new collectors via `registerReferenceCollector()` at module level.
 */
export type ReferenceCollector = (obj: AlObject, packages: AlPackage[]) => ReferenceProperty[];

const referenceCollectors: ReferenceCollector[] = [];

/**
 * Register a collector that contributes navigatable reference properties.
 *
 * Call this at module level in any plugin that wants to extend object
 * navigation.  Collectors are invoked in registration order.
 */
export function registerReferenceCollector(collector: ReferenceCollector): void {
    referenceCollectors.push(collector);
}

// ---------------------------------------------------------------------------
// Built-in collectors
// ---------------------------------------------------------------------------

/** Maps *Extension object types to the base type they extend. */
function extensionBaseType(extType: AlObjectType): AlObjectType | undefined {
    switch (extType) {
        case 'TableExtension':          return 'Table';
        case 'PageExtension':           return 'Page';
        case 'ReportExtension':         return 'Report';
        case 'EnumExtension':           return 'Enum';
        case 'PermissionSetExtension':  return 'PermissionSet';
        case 'ProfileExtension':        return 'Profile';
        default: return undefined;
    }
}

// ── Extends: any extension object → its base object ─────────────────────────
registerReferenceCollector((obj) => {
    if (!obj.extendsName) { return []; }
    const baseType = extensionBaseType(obj.type);
    if (!baseType) { return []; }
    return [{
        label: `$(type-hierarchy-sub) Extends ${baseType}: "${obj.extendsName}"`,
        description: baseType,
        refName: obj.extendsName,
        targetTypes: [baseType],
    }];
});

// ── SourceTable: Page objects ────────────────────────────────────────────────
registerReferenceCollector((obj) => {
    if (obj.type !== 'Page' || !obj.sourceTable) { return []; }
    return [{
        label: `$(database) Source Table: "${obj.sourceTable}"`,
        description: 'Table',
        refName: obj.sourceTable,
        targetTypes: ['Table'],
    }];
});

// ── SourceTable via the extended page: PageExtension objects ─────────────────
// A PageExtension does not declare SourceTable itself; the value lives on the
// base page.  This collector resolves the base page and reads its SourceTable
// so the developer can navigate there directly without opening the base page
// first.
registerReferenceCollector((obj, packages) => {
    if (obj.type !== 'PageExtension' || !obj.extendsName) { return []; }

    const basePage = resolveObjectReference(
        obj.extendsName, ['Page'], obj.namespace, obj.usings, packages
    );
    if (!basePage?.sourceTable) { return []; }

    return [{
        label: `$(database) Source Table: "${basePage.sourceTable}"`,
        description: `Table (via Page "${basePage.name}")`,
        refName: basePage.sourceTable,
        targetTypes: ['Table'],
    }];
});

// ── Implements: Codeunit and Enum objects ────────────────────────────────────
// A Codeunit or Enum can implement one or more interfaces.  Each implemented
// interface is presented as a navigatable reference.
registerReferenceCollector((obj) => {
    if ((obj.type !== 'Codeunit' && obj.type !== 'Enum') || !obj.implementsNames) { return []; }

    return obj.implementsNames.map((ifaceName, idx) => ({
        label: `$(type-hierarchy-super) Implements: "${ifaceName}"`,
        description: 'Interface',
        refName: ifaceName,
        targetTypes: ['Interface'],
    }));
});

// ---------------------------------------------------------------------------
// Namespace-aware object resolution
// ---------------------------------------------------------------------------

/**
 * Strip any namespace prefix from a reference name, returning only the bare
 * object name that should be matched against `AlObject.name`.
 *
 * AL reference forms handled:
 * - `Microsoft.Sales."Sales Header"`  → `Sales Header`
 * - `Microsoft.Sales.Customer`        → `Customer`
 * - `"Sales Header"`                  → `Sales Header`
 * - `Customer`                        → `Customer`
 */
function stripNamespacePrefix(ref: string): string {
    // Namespace."Quoted Name" — take the quoted portion
    const quotedSuffix = ref.match(/\."([^"]+)"\s*$/);
    if (quotedSuffix) { return quotedSuffix[1]; }

    // Namespace.UnquotedName — take the last dot-separated segment
    const dotIdx = ref.lastIndexOf('.');
    if (dotIdx >= 0) { return ref.slice(dotIdx + 1); }

    return ref;
}

/**
 * Resolve a reference name to a single AlObject using namespace context.
 *
 * Matching priority (highest → lowest):
 * 1. Object whose namespace equals the source object's own namespace.
 * 2. Object whose namespace appears in the source object's `using` directives.
 * 3. Object with no namespace (global / base BC symbols such as Customer).
 * 4. Any other matching object (different namespace, not imported).
 *
 * When multiple objects tie at the same priority level, the first one found
 * wins — consistent with the AL compiler's own resolution behaviour.
 * In practice a well-formed project should never produce a tie above level 4.
 *
 * Returns `undefined` when no object with that name and type can be found.
 */
function resolveObjectReference(
    refName: string,
    targetTypes: AlObjectType[],
    sourceNamespace: string | undefined,
    sourceUsings: string[] | undefined,
    packages: AlPackage[]
): AlObject | undefined {
    const bare = stripNamespacePrefix(refName).toLowerCase();
    const usings = sourceUsings ?? [];

    let sameNs: AlObject | undefined;
    let inUsings: AlObject | undefined;
    let global: AlObject | undefined;
    let other: AlObject | undefined;

    outer:
    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            if (!targetTypes.includes(obj.type)) { continue; }
            if (obj.name.toLowerCase() !== bare) { continue; }

            const objNs = obj.namespace ?? '';

            if (!objNs) {
                global ??= obj;
            } else if (sourceNamespace && objNs === sourceNamespace) {
                sameNs = obj;
                break outer;     // can't get higher priority, stop searching
            } else if (usings.includes(objNs)) {
                inUsings ??= obj;
            } else {
                other ??= obj;
            }
        }
    }

    return sameNs ?? inUsings ?? global ?? other;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function navigateToReferencedObjectCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('AL Companion: No active editor.');
        return;
    }

    const packages = getPackages();
    if (packages.length === 0) {
        vscode.window.showWarningMessage('No packages loaded. Run "AL Companion: Reload Packages" first.');
        return;
    }

    // ── Identify the AlObject for the active document ────────────────────────
    const docUri = editor.document.uri;
    let currentObj: AlObject | undefined;
    let currentPkg: AlPackage | undefined;

    if (docUri.scheme === 'file') {
        const fsPath = docUri.fsPath;
        for (const pkg of packages) {
            const obj = pkg.objects.find(o => o.sourceFilePath === fsPath);
            if (obj) { currentObj = obj; currentPkg = pkg; break; }
        }
    } else if (docUri.scheme === 'al-companion-app') {
        const entryName = docUri.path.slice(1);
        const pkgPath = new URLSearchParams(docUri.query).get('path');
        for (const pkg of packages) {
            if (pkgPath && pkg.filePath !== pkgPath) { continue; }
            const obj = pkg.objects.find(o => o.zipEntryName === entryName);
            if (obj) { currentObj = obj; currentPkg = pkg; break; }
        }
    }

    if (!currentObj || !currentPkg) {
        vscode.window.showErrorMessage(
            'AL Companion: Could not identify the AL object in the active editor. ' +
            'Try "AL Companion: Reload Packages".'
        );
        return;
    }

    // ── Collect all navigatable reference properties ─────────────────────────
    const properties: ReferenceProperty[] = referenceCollectors.flatMap(collector => {
        try {
            return collector(currentObj!, packages);
        } catch (err) {
            logger.error('ReferenceCollector threw an error', err);
            return [];
        }
    });

    if (properties.length === 0) {
        vscode.window.showInformationMessage(
            `AL Companion: "${currentObj.name}" has no navigatable references ` +
            `(no extends, SourceTable, or other registered reference property).`
        );
        return;
    }

    // ── When multiple references exist, let the user choose one ──────────────
    let chosen: ReferenceProperty;

    if (properties.length === 1) {
        chosen = properties[0];
    } else {
        type PropItem = vscode.QuickPickItem & { prop: ReferenceProperty };
        const items: PropItem[] = properties.map(p => ({
            label: p.label,
            description: p.description,
            prop: p,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: `Navigate from ${currentObj.type} "${currentObj.name}"`,
            placeHolder: 'Select the reference to open',
        });
        if (!picked) { return; }
        chosen = picked.prop;
    }

    // ── Resolve the target object ─────────────────────────────────────────────
    const target = resolveObjectReference(
        chosen.refName,
        chosen.targetTypes,
        currentObj.namespace,
        currentObj.usings,
        packages
    );

    logger.debug(
        `Navigate: "${chosen.refName}" (${chosen.targetTypes.join('|')}) → ` +
        (target ? `${target.type} "${target.name}"` : 'not found')
    );

    if (!target) {
        vscode.window.showWarningMessage(
            `AL Companion: Could not find "${chosen.refName}" in loaded packages. ` +
            `Try "AL Companion: Reload Packages" to refresh symbols.`
        );
        return;
    }

    // Find the package that owns the target object (reference equality works
    // because all AlObject instances come from the same in-memory store).
    const targetPkg = packages.find(p => p.objects.includes(target)) ?? currentPkg;
    await showAlObjectUsingPreviewScheme(target, targetPkg);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('al-companion.navigateToReferencedObject', () => {
            navigateToReferencedObjectCommand().catch(err => {
                vscode.window.showErrorMessage(`Navigate error — ${err}`);
            });
        })
    );
}
