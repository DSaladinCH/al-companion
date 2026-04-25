import * as vscode from 'vscode';
import * as path from 'path';
import { AlElement, AlFunction, AlObjectType, AlObject, AlPackage } from '../types';
import { getPackages, getStoreVersion } from '../packageStore';
import { showAlObjectUsingPreviewScheme } from '../commands';

// ---------------------------------------------------------------------------
// Quick-pick item
// ---------------------------------------------------------------------------

interface SearchResult extends vscode.QuickPickItem {
    filePath: string;
    line: number;
    obj: AlObject;        // Reference to the source AL object
    pkg: AlPackage;       // Reference to the package
    /**
     * Extra search tokens not covered by the dedicated name fields:
     * object ID, element ID (where applicable), and the kind keyword
     * ("object" | "trigger" | "procedure" | element kind).
     * Kept intentionally small to reduce per-item memory.
     */
    extraText: string;
    // Decomposed zones used for fine-grained scoring:
    memberName: string;   // lower-cased procedure / field / action / object name
    captionName: string;  // lower-cased Caption property value (empty when absent)
    objectName: string;   // lower-cased AL object name
    extendsName: string;  // lower-cased extends target (empty string when none)
    fileName: string;     // lower-cased filename without extension
    objectType: string;   // lower-cased object type
    /** Computed match score 0–100 (set after scoring, 0 before query). */
    score: number;
    /** Human-readable description without score prefix (stored for re-stamping). */
    baseDescription: string;
}

// ---------------------------------------------------------------------------
// Result cache (invalidated on each package reload via storeVersion)
// ---------------------------------------------------------------------------

let cachedResults: SearchResult[] | null = null;
let cachedStoreVersion = -1;

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function iconForElement(kind: AlElement['kind']): string {
    switch (kind) {
        case 'field':     return '$(symbol-field)';
        case 'action':    return '$(symbol-event)';
        case 'enumValue': return '$(symbol-enum-member)';
        case 'column':    return '$(symbol-property)';
        default:          return '$(symbol-misc)';
    }
}

function iconForFunction(fn: AlFunction): string {
    return fn.isTrigger ? '$(symbol-function)' : '$(symbol-method)';
}

function iconForObjectType(type: AlObjectType): string {
    switch (type) {
        case 'Table':                  return '$(database)';
        case 'TableExtension':         return '$(database)';
        case 'Page':                   return '$(browser)';
        case 'PageExtension':          return '$(browser)';
        case 'Codeunit':               return '$(symbol-class)';
        case 'Enum':                   return '$(symbol-enum)';
        case 'EnumExtension':          return '$(symbol-enum)';
        case 'Report':                 return '$(graph)';
        case 'ReportExtension':        return '$(graph)';
        case 'Query':                  return '$(search)';
        case 'XmlPort':                return '$(symbol-interface)';
        case 'Interface':              return '$(symbol-interface)';
        case 'PermissionSet':          return '$(shield)';
        case 'PermissionSetExtension': return '$(shield)';
        default:                       return '$(symbol-namespace)';
    }
}

// ---------------------------------------------------------------------------
// Build results from the in-memory package store (local files only)
// ---------------------------------------------------------------------------

function buildResults(): SearchResult[] {
    const currentVersion = getStoreVersion();
    if (cachedResults !== null && cachedStoreVersion === currentVersion) {
        // Reset mutations from any previous search session before reusing.
        for (const r of cachedResults) {
            r.score = 0;
            r.description = r.baseDescription;
        }
        return cachedResults;
    }

    const results: SearchResult[] = [];

    for (const pkg of getPackages()) {
        for (const obj of pkg.objects) {
            if (!obj.sourceFilePath) { continue; } // local files only

            const filePath = obj.sourceFilePath;
            const fileName = path.basename(filePath, '.al').toLowerCase();
            const relPath = vscode.workspace.asRelativePath(filePath, true);
            const objectName = obj.name.toLowerCase();
            const extendsName = obj.extendsName?.toLowerCase() ?? '';
            const objectType = obj.type.toLowerCase();

            const objCaptionLower = obj.caption?.toLowerCase() ?? '';
            const objCaptionNote = obj.caption && obj.caption.toLowerCase() !== objectName
                ? `  ·  "${obj.caption}"`
                : '';

            const baseDescriptionNoCaption = obj.extendsName
                ? `${obj.type} "${obj.name}" extends "${obj.extendsName}"`
                : `${obj.type} "${obj.name}"`;
            const baseDescription = `${baseDescriptionNoCaption}${objCaptionNote}`;

            // ── Object itself ────────────────────────────────────────────────
            {
                const idSuffix = obj.id > 0 ? ` (${obj.id})` : '';
                const objBaseDesc = `${obj.type}${obj.extendsName ? ` extends "${obj.extendsName}"` : ''}${objCaptionNote}`;
                results.push({
                    label: `${iconForObjectType(obj.type)} ${obj.name}${idSuffix}`,
                    description: objBaseDesc,
                    detail: relPath,
                    alwaysShow: true,
                    filePath,
                    line: obj.line,
                    obj,
                    pkg,
                    extraText: obj.id > 0 ? `${obj.id} object` : 'object',
                    memberName: objectName,
                    captionName: objCaptionLower,
                    objectName, extendsName, fileName, objectType,
                    score: 0,
                    baseDescription: objBaseDesc,
                });
            }

            // ── Functions / procedures / triggers ───────────────────────────
            for (const fn of obj.functions) {
                const memberName = fn.name.toLowerCase();
                const captionName = fn.caption?.toLowerCase() ?? '';
                const captionNote = fn.caption && fn.caption.toLowerCase() !== memberName
                    ? `  ·  "${fn.caption}"`
                    : '';
                const fnBaseDesc = `${baseDescription}${captionNote}`;
                results.push({
                    label: `${iconForFunction(fn)} ${fn.name}`,
                    description: fnBaseDesc,
                    detail: relPath,
                    alwaysShow: true,
                    filePath,
                    line: fn.line,
                    obj,
                    pkg,
                    extraText: `${obj.id > 0 ? obj.id + ' ' : ''}${fn.isTrigger ? 'trigger' : 'procedure'}`,
                    memberName, captionName, objectName, extendsName, fileName, objectType,
                    score: 0,
                    baseDescription: fnBaseDesc,
                });
            }

            // ── Non-function elements (fields, actions, enum values, …) ────
            for (const el of obj.elements) {
                const memberName = el.name.toLowerCase();
                const captionName = el.caption?.toLowerCase() ?? '';
                const captionNote = el.caption && el.caption.toLowerCase() !== memberName
                    ? `  ·  "${el.caption}"`
                    : '';
                const elBaseDesc = `${baseDescription}${captionNote}`;
                const idStr = el.id !== undefined ? String(el.id) : '';
                const labelSuffix = el.id !== undefined ? ` (${el.id})` : '';
                results.push({
                    label: `${iconForElement(el.kind)} ${el.name}${labelSuffix}`,
                    description: elBaseDesc,
                    detail: relPath,
                    alwaysShow: true,
                    filePath,
                    line: el.line,
                    obj,
                    pkg,
                    extraText: [obj.id > 0 ? String(obj.id) : '', idStr, el.kind].filter(Boolean).join(' '),
                    memberName, captionName, objectName, extendsName, fileName, objectType,
                    score: 0,
                    baseDescription: elBaseDesc,
                });
            }
        }
    }

    cachedResults = results;
    cachedStoreVersion = currentVersion;
    return results;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Returns true when `needle` starts at a word boundary inside `haystack`
 * (position 0, or preceded by a space, underscore, dot, dash, or quote).
 */
function matchesWordStart(haystack: string, needle: string): boolean {
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        if (pos === 0 || /[\s_.\-"]/.test(haystack[pos - 1])) { return true; }
        pos++;
    }
    return false;
}

/**
 * Score a single token against a result (0–100).
 * Higher means a more specific / prominent match.
 */
function scoreToken(r: SearchResult, token: string): number {
    const cn = r.captionName;

    // ── Exact matches ─────────────────────────────────────────────────────────
    if (r.memberName === token)                          { return 100; }
    if (cn && cn === token)                              { return 95; }
    if (r.objectName === token)                          { return 75; }

    // ── Prefix matches ────────────────────────────────────────────────────────
    if (r.memberName.startsWith(token))                  { return 85; }
    if (cn && cn.startsWith(token))                      { return 80; }
    if (r.objectName.startsWith(token))                  { return 60; }
    if (r.extendsName && r.extendsName.startsWith(token)){ return 55; }
    if (r.fileName.startsWith(token))                    { return 50; }

    // ── Word-boundary matches ─────────────────────────────────────────────────
    if (matchesWordStart(r.memberName, token))           { return 70; }
    if (cn && matchesWordStart(cn, token))               { return 65; }
    if (matchesWordStart(r.objectName, token))           { return 48; }
    if (r.extendsName && matchesWordStart(r.extendsName, token)) { return 43; }
    if (matchesWordStart(r.fileName, token))              { return 38; }

    // ── Substring matches ─────────────────────────────────────────────────────
    if (r.memberName.includes(token))                    { return 55; }
    if (cn && cn.includes(token))                        { return 50; }
    if (r.objectName.includes(token))                    { return 33; }
    if (r.extendsName && r.extendsName.includes(token))  { return 28; }
    if (r.fileName.includes(token))                      { return 23; }

    // ── Object type (e.g. "codeunit", "table", "pageextension") ────────────────
    if (r.objectType === token)                          { return 12; }
    if (r.objectType.startsWith(token))                  { return  8; }
    if (r.objectType.includes(token))                    { return  5; }

    // ── Fallback: id, kind, trigger/procedure keyword ─────────────────────────
    if (r.extraText.includes(token))                     { return 10; }

    return 0;
}

/**
 * Score a result against the full token list (average per-token score, 0–100).
 * Returns -1 when at least one token does not match at all (hard filter).
 */
function scoreResult(r: SearchResult, tokens: string[]): number {
    let total = 0;
    for (const token of tokens) {
        const s = scoreToken(r, token);
        if (s === 0) { return -1; } // token not matched → exclude
        total += s;
    }
    return Math.round(total / tokens.length);
}

/**
 * Filter results by requiring every token to match, then sort by score desc.
 * Stamps the computed score onto each kept item and updates its description.
 */
function scoreAndFilter(all: SearchResult[], query: string): SearchResult[] {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);

    if (tokens.length === 0) {
        // No query: restore plain descriptions and return all
        for (const r of all) {
            r.score = 0;
            r.description = r.baseDescription;
        }
        return all;
    }

    const scored: SearchResult[] = [];
    for (const r of all) {
        const s = scoreResult(r, tokens);
        if (s < 0) { continue; }
        r.score = s;
        r.description = `${s}%  ·  ${r.baseDescription}`;
        scored.push(r);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function openResult(result: SearchResult): Promise<void> {
    await showAlObjectUsingPreviewScheme(result.obj, result.pkg, result.line);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function searchLocalFilesCommand(): Promise<void> {
    const allResults = buildResults();

    if (allResults.length === 0) {
        const hasLocal = getPackages().some(p => p.objects.some(o => !!o.sourceFilePath));
        if (!hasLocal) {
            vscode.window.showWarningMessage(
                'No local AL workspace files found. Make sure an AL project is open and packages are loaded.'
            );
        } else {
            vscode.window.showInformationMessage('No searchable elements found in local AL files.');
        }
        return;
    }

    const qp = vscode.window.createQuickPick<SearchResult>();
    qp.placeholder = 'Type tokens to search: file name, object, extends, field/action name, ID… (e.g. "cont name 3")';
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.items = allResults;

    const changeDisposable = qp.onDidChangeValue(value => {
        qp.items = scoreAndFilter(allResults, value);
    });

    const acceptDisposable = qp.onDidAccept(async () => {
        const selected = qp.selectedItems[0];
        qp.hide();
        if (selected) {
            await openResult(selected);
        }
    });

    const hideDisposable = qp.onDidHide(() => {
        changeDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        qp.dispose();
    });

    qp.show();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('al-companion.searchLocalFiles', searchLocalFilesCommand)
    );
}
