import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import * as he from 'he';
import { getPackages, getStoreVersion } from '../packageStore';
import { getPackageById } from '../packageStore';
import { findZipStart } from '../packageReader';
import { AlPackage } from '../types';
import { showAlObjectUsingPreviewScheme } from '../commands';
import * as logger from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface XlfSearchEntry extends vscode.QuickPickItem {
    // Search zones — all lowercase
    sourceLower: string;
    targetsLower: string;
    noteLower: string;
    objTypeLower: string;
    objNameLower: string;
    memberNameLower: string;
    propTypeLower: string;
    /** Numeric object ID as decimal string for user ID searches. */
    objIdStr: string;

    /**
     * Original-case source text, truncated.
     * Shown as description (same-line, lighter) when the label shows a translation,
     * so the user can confirm the source meaning alongside the found translation.
     */
    sourceText: string;
    /** Language code of the first available translation, e.g. "de-DE". Empty when none. */
    firstTargetLang: string;
    /** First translation text that differs from source, truncated. Empty when none. */
    firstTargetText: string;

    // Navigation
    pkgId: string;
    objType: string;
    objId: number;
    memberNameOrig: string;

    score: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedEntries: XlfSearchEntry[] | null = null;
let cachedStoreVersion = -1;

/**
 * Per-package XLIFF cache keyed by .app file path.
 * Package files are immutable once loaded, so this survives storeVersion bumps.
 */
const pkgXlfCache = new Map<string, XlfSearchEntry[]>();

// ---------------------------------------------------------------------------
// XLIFF parsing — indexOf-based scanner (no regex backtracking, no stack risk)
// ---------------------------------------------------------------------------

interface RawTransUnit {
    id: string;
    source: string;
    target: string;  // empty string when absent or identical to source
    note: string;
}

interface ParsedXliff {
    /** BCP-47 language code from the <file target-language="…"> attribute. */
    targetLanguage: string;
    units: RawTransUnit[];
}

/**
 * Extract the text content between <tagName …> and </tagName>.
 * Returns null when the tag is absent; returns '' for self-closing tags.
 */
function extractTagText(body: string, tagName: string): string | null {
    const openTag = `<${tagName}`;
    const closeTag = `</${tagName}>`;

    const tagStart = body.indexOf(openTag);
    if (tagStart === -1) { return null; }

    const gtPos = body.indexOf('>', tagStart);
    if (gtPos === -1) { return null; }
    if (body[gtPos - 1] === '/') { return ''; }  // self-closing

    const contentEnd = body.indexOf(closeTag, gtPos + 1);
    if (contentEnd === -1) { return null; }

    return body.slice(gtPos + 1, contentEnd);
}

/**
 * Extract the text of the <note from="Xliff Generator"> element inside body.
 *
 * AL XLIFF trans-units carry TWO notes: one from "Developer" (free-form
 * comments — may contain arbitrary text like "#1" or bug references) and one
 * from "Xliff Generator" (always the structured "Table X - Field Y - Property Z"
 * path used for navigation). We must skip the developer note entirely.
 */
function extractNoteText(body: string): string {
    let pos = 0;
    while (pos < body.length) {
        const tagStart = body.indexOf('<note', pos);
        if (tagStart === -1) { break; }

        const gtPos = body.indexOf('>', tagStart);
        if (gtPos === -1) { break; }

        const attrs = body.slice(tagStart, gtPos);

        const closeIdx = body.indexOf('</note>', gtPos + 1);
        if (closeIdx === -1) { break; }

        pos = closeIdx + 7;

        // Skip every note that is not from the Xliff Generator
        if (!attrs.includes('Xliff Generator')) { continue; }

        const text = body.slice(gtPos + 1, closeIdx).trim();
        if (text) { return text; }
    }
    return '';
}

/** Read the target-language attribute from the <file> element of an XLIFF document. */
function extractTargetLanguage(content: string): string {
    const fileStart = content.indexOf('<file');
    if (fileStart === -1) { return ''; }

    const gtPos = content.indexOf('>', fileStart);
    if (gtPos === -1) { return ''; }

    const attrs = content.slice(fileStart, gtPos);
    const attrKey = 'target-language="';
    const keyPos = attrs.indexOf(attrKey);
    if (keyPos === -1) { return ''; }

    const valStart = keyPos + attrKey.length;
    const valEnd = attrs.indexOf('"', valStart);
    return valEnd === -1 ? '' : attrs.slice(valStart, valEnd);
}

/**
 * Parse all trans-unit elements from an XLIFF string.
 *
 * Uses a plain indexOf scan instead of a greedy/lazy regex, which avoids the
 * "Maximum call stack size exceeded" error that V8's regex engine can throw on
 * very large XLIFF files (e.g. Microsoft Base Application with 26 XLF files).
 */
function parseXliff(content: string): ParsedXliff {
    const targetLanguage = extractTargetLanguage(content);
    const units: RawTransUnit[] = [];
    const OPEN  = '<trans-unit';
    const CLOSE = '</trans-unit>';
    let pos = 0;

    while (pos < content.length) {
        const start = content.indexOf(OPEN, pos);
        if (start === -1) { break; }

        // Locate the id attribute value — must be inside the opening tag
        const gtPos = content.indexOf('>', start);
        if (gtPos === -1) { break; }

        const idAttrPos = content.indexOf('id="', start);
        if (idAttrPos === -1 || idAttrPos > gtPos) { pos = gtPos + 1; continue; }

        const idStart = idAttrPos + 4;
        const idEnd = content.indexOf('"', idStart);
        if (idEnd === -1 || idEnd > gtPos) { pos = gtPos + 1; continue; }
        const id = content.slice(idStart, idEnd);

        // Body: everything between end of opening tag and </trans-unit>
        const bodyStart = gtPos + 1;
        const bodyEnd = content.indexOf(CLOSE, bodyStart);
        if (bodyEnd === -1) { break; }

        pos = bodyEnd + CLOSE.length;
        const body = content.slice(bodyStart, bodyEnd);

        // Extract <source>
        const srcRaw = extractTagText(body, 'source');
        if (srcRaw === null) { continue; }
        const source = he.decode(srcRaw);
        if (!source) { continue; }

        // Extract <target> (may carry a state="…" attribute)
        const tgtRaw = extractTagText(body, 'target') ?? '';
        const target = tgtRaw ? he.decode(tgtRaw) : '';

        // Extract the Xliff Generator note only
        const note = extractNoteText(body);

        units.push({ id, source, target: target === source ? '' : target, note });
    }

    return { targetLanguage, units };
}

// ---------------------------------------------------------------------------
// ID / note parsing
// ---------------------------------------------------------------------------

interface ParsedXlfId {
    objType: string;
    objId: number;
}

function parseXlfId(id: string): ParsedXlfId {
    const dash = id.indexOf(' - ');
    const first = dash === -1 ? id : id.slice(0, dash);
    const sp = first.indexOf(' ');
    return {
        objType: sp === -1 ? first : first.slice(0, sp),
        objId:   sp === -1 ? 0     : parseInt(first.slice(sp + 1), 10),
    };
}

interface ParsedNote {
    objType: string;
    objName: string;
    memberName: string;
    propType: string;
}

/**
 * Parse a note like "Table RIB Category - Field Code - Property Caption".
 * Last segment is always property/type; any middle segment is the member.
 */
function parseXlfNote(note: string): ParsedNote {
    const empty: ParsedNote = { objType: '', objName: '', memberName: '', propType: '' };
    if (!note) { return empty; }

    const parts = note.split(' - ');

    const firstSp = parts[0].indexOf(' ');
    if (firstSp === -1) { return empty; }
    const objType = parts[0].slice(0, firstSp);
    const objName = parts[0].slice(firstSp + 1);

    if (parts.length < 2) {
        return { objType, objName, memberName: '', propType: '' };
    }

    const lastPart = parts[parts.length - 1];
    let propType: string;
    if (lastPart.startsWith('Property '))     { propType = lastPart.slice(9); }
    else if (lastPart.startsWith('NamedType '))  { propType = 'Label'; }
    else if (lastPart.startsWith('ReportLabel ')) { propType = 'Report Label'; }
    else                                          { propType = lastPart; }

    let memberName = '';
    if (parts.length >= 3) {
        const mp = parts[1];
        const sp = mp.indexOf(' ');
        memberName = sp === -1 ? '' : mp.slice(sp + 1);
    }

    return { objType, objName, memberName, propType };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function iconForPropType(propType: string): string {
    switch (propType.toLowerCase()) {
        case 'caption':       return '$(symbol-string)';
        case 'tooltip':       return '$(comment)';
        case 'optioncaption': return '$(symbol-enum-member)';
        case 'label':         return '$(symbol-variable)';
        case 'report label':  return '$(graph)';
        default:              return '$(globe)';
    }
}

// ---------------------------------------------------------------------------
// Build entries from a set of XLF file contents belonging to one package
// ---------------------------------------------------------------------------

function buildPackageXlfEntries(pkg: AlPackage, parsedXliffs: ParsedXliff[]): XlfSearchEntry[] {
    // Merge all language files: same trans-unit id → combine targets.
    // The first language file that has a non-source translation wins for display.
    const merged = new Map<string, {
        source: string;
        firstTargetLang: string;
        firstTargetText: string;
        allTargets: string[];
        note: string;
    }>();

    for (const { targetLanguage, units } of parsedXliffs) {
        for (const unit of units) {
            const existing = merged.get(unit.id);
            if (existing) {
                if (unit.target) { existing.allTargets.push(unit.target); }
            } else {
                const tgt = unit.target;
                const tgtDisplay = tgt
                    ? (tgt.length > 60 ? tgt.slice(0, 59) + '\u2026' : tgt)
                    : '';
                merged.set(unit.id, {
                    source: unit.source,
                    firstTargetLang: tgt ? targetLanguage : '',
                    firstTargetText: tgtDisplay,
                    allTargets: tgt ? [tgt] : [],
                    note: unit.note,
                });
            }
        }
    }

    const isLocal = pkg.objects.some(o => !!o.sourceFilePath);
    const pkgLabel = isLocal
        ? `Local: ${pkg.name}`
        : `${pkg.publisher} \u00B7 ${pkg.name} ${pkg.version}`;

    const entries: XlfSearchEntry[] = [];

    for (const [id, data] of merged) {
        const idInfo  = parseXlfId(id);
        const note    = parseXlfNote(data.note);

        const objType    = note.objType    || idInfo.objType;
        const objName    = note.objName;
        const memberName = note.memberName;
        const propType   = note.propType   || 'Property';

        const source      = data.source;
        const sourceText  = source.length > 80 ? source.slice(0, 79) + '\u2026' : source;
        const targetsStr  = data.allTargets.join(' ');

        const { firstTargetLang, firstTargetText } = data;

        // ── Label (title line) ───────────────────────────────────────────────
        // Show the found/translated text prominently.
        // If a translation exists, show "[LANG] translated text";
        // otherwise fall back to the source text.
        const langTag     = firstTargetLang
            ? `[${firstTargetLang.split('-')[0].toUpperCase()}] `
            : '';
        const displayText = firstTargetText || sourceText;
        const label = `${iconForPropType(propType)} ${langTag}${displayText}`;

        // ── Description (same line, lighter) ────────────────────────────────
        // When the label shows a translation, echo the source text here so the
        // user can confirm the original meaning at a glance.
        const description = firstTargetText ? sourceText : '';

        // ── Detail (subtitle below label) ────────────────────────────────────
        // Object context + package. Static — never modified during scoring.
        const memberPart = memberName ? ` \u00B7 ${memberName}` : '';
        const detail = `${objType} \u201C${objName}\u201D${memberPart} \u00B7 ${propType}  |  ${pkgLabel}`;

        entries.push({
            label,
            description,
            detail,
            alwaysShow: false,
            sourceLower:      source.toLowerCase(),
            targetsLower:     targetsStr.toLowerCase(),
            noteLower:        data.note.toLowerCase(),
            objTypeLower:     objType.toLowerCase(),
            objNameLower:     objName.toLowerCase(),
            memberNameLower:  memberName.toLowerCase(),
            propTypeLower:    propType.toLowerCase(),
            objIdStr:         String(idInfo.objId),
            sourceText,
            firstTargetLang,
            firstTargetText,
            pkgId:            pkg.id,
            objType,
            objId:            idInfo.objId,
            memberNameOrig:   memberName,
            score:            0,
        });
    }

    return entries;
}

// ---------------------------------------------------------------------------
// XLF file discovery (local workspace)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.alpackages', '.git', '.vs', 'node_modules', 'out', '.output']);

function collectXlfFiles(dir: string): string[] {
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectXlfFiles(full));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xlf')) {
                results.push(full);
            }
        }
    } catch (err) {
        logger.error(`Cannot read directory ${dir}`, err);
    }
    return results;
}

// ---------------------------------------------------------------------------
// Load XLIFF entries from a .app ZIP
// ---------------------------------------------------------------------------

async function loadPackageXlfEntries(pkg: AlPackage): Promise<XlfSearchEntry[]> {
    let rawBuffer: Buffer;
    try {
        rawBuffer = await fs.promises.readFile(pkg.filePath);
    } catch (err) {
        logger.error(`Cannot read package ${pkg.filePath}`, err);
        return [];
    }

    const zipBuffer = findZipStart(rawBuffer);
    if (!zipBuffer) { return []; }

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(zipBuffer);
    } catch (err) {
        logger.error(`Cannot load ZIP ${pkg.filePath}`, err);
        return [];
    }

    const xlfFiles = Object.values(zip.files).filter(
        f => !f.dir && f.name.toLowerCase().endsWith('.xlf')
    );
    if (xlfFiles.length === 0) { return []; }

    const parsedXliffs: ParsedXliff[] = [];
    for (const xlfFile of xlfFiles) {
        try {
            parsedXliffs.push(parseXliff(await xlfFile.async('string')));
        } catch (err) {
            logger.error(`Cannot extract ${xlfFile.name} from ${pkg.filePath}`, err);
        }
    }

    const entries = buildPackageXlfEntries(pkg, parsedXliffs);
    logger.debug(`Parsed ${xlfFiles.length} XLF file(s) from ${path.basename(pkg.filePath)} — ${entries.length} entries`);
    return entries;
}

// ---------------------------------------------------------------------------
// Main cache builder
// ---------------------------------------------------------------------------

async function buildEntries(): Promise<XlfSearchEntry[]> {
    const currentVersion = getStoreVersion();

    if (cachedEntries !== null && cachedStoreVersion === currentVersion) {
        for (const e of cachedEntries) { e.score = 0; }
        return cachedEntries;
    }

    const allEntries: XlfSearchEntry[] = [];
    const currentPkgPaths = new Set<string>();

    for (const pkg of getPackages()) {
        currentPkgPaths.add(pkg.filePath);
        const isLocal = pkg.objects.some(o => !!o.sourceFilePath);

        if (isLocal) {
            const folderPath = path.dirname(pkg.filePath); // pkg.filePath = app.json
            const xlfFiles = collectXlfFiles(folderPath);
            if (xlfFiles.length === 0) { continue; }

            const parsedXliffs: ParsedXliff[] = [];
            for (const xlfFile of xlfFiles) {
                try {
                    const content = await fs.promises.readFile(xlfFile, 'utf8');
                    parsedXliffs.push(parseXliff(content));
                } catch (err) {
                    logger.error(`Cannot read XLF file ${xlfFile}`, err);
                }
            }

            if (parsedXliffs.length > 0) {
                const entries = buildPackageXlfEntries(pkg, parsedXliffs);
                logger.debug(`Parsed ${xlfFiles.length} local XLF file(s) — ${entries.length} entries`);
                for (const e of entries) { allEntries.push(e); }
            }
        } else {
            // Package: use per-file cache (packages are immutable after load)
            let entries = pkgXlfCache.get(pkg.filePath);
            if (!entries) {
                entries = await loadPackageXlfEntries(pkg);
                pkgXlfCache.set(pkg.filePath, entries);
            }
            for (const e of entries) { allEntries.push(e); }
        }
    }

    // Evict cache entries for packages no longer in the store
    for (const cachedPath of pkgXlfCache.keys()) {
        if (!currentPkgPaths.has(cachedPath)) {
            pkgXlfCache.delete(cachedPath);
        }
    }

    cachedEntries = allEntries;
    cachedStoreVersion = currentVersion;
    logger.log(`Translation index built: ${allEntries.length} entries across ${getPackages().length} package(s).`);
    return allEntries;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function matchesWordBoundary(haystack: string, needle: string): boolean {
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        if (pos === 0 || /[\s_."\-']/.test(haystack[pos - 1])) { return true; }
        pos++;
    }
    return false;
}

/** Maximum number of results shown in the QuickPick at any time. */
const MAX_RESULTS = 200;

/**
 * Score a single lowercase token against one entry (0–100).
 * Takes the maximum across all search zones so a token matching both the
 * source text and a member name gets the higher of the two scores.
 */
function scoreToken(e: XlfSearchEntry, token: string): number {
    let best = 0;
    function take(s: number): void { if (s > best) { best = s; } }

    // Source text (the translation string itself)
    if (e.sourceLower === token)                              { take(100); }
    else if (e.sourceLower.startsWith(token))                { take(85); }
    else if (matchesWordBoundary(e.sourceLower, token))      { take(70); }
    else if (e.sourceLower.includes(token))                  { take(55); }

    // Member name (field / method / action)
    if (e.memberNameLower) {
        if (e.memberNameLower === token)                     { take(90); }
        else if (e.memberNameLower.startsWith(token))        { take(75); }
        else if (matchesWordBoundary(e.memberNameLower, token)) { take(60); }
        else if (e.memberNameLower.includes(token))          { take(45); }
    }

    // Object name
    if (e.objNameLower === token)                            { take(80); }
    else if (e.objNameLower.startsWith(token))               { take(65); }
    else if (matchesWordBoundary(e.objNameLower, token))     { take(50); }
    else if (e.objNameLower.includes(token))                 { take(35); }

    // Target translations (any language)
    if (e.targetsLower.includes(token)) {
        if (matchesWordBoundary(e.targetsLower, token))      { take(65); }
        else                                                 { take(50); }
    }

    // Property type ("Caption", "ToolTip", "Label", …)
    if (e.propTypeLower === token)                           { take(25); }
    else if (e.propTypeLower.startsWith(token))              { take(18); }
    else if (e.propTypeLower.includes(token))                { take(12); }

    // Object type ("table", "codeunit", …)
    if (e.objTypeLower === token)                            { take(20); }
    else if (e.objTypeLower.startsWith(token))               { take(12); }

    // Numeric object ID
    if (e.objIdStr === token)                                { take(20); }

    // Raw note fallback (catches member-type keywords like "field", "method")
    if (best === 0 && e.noteLower.includes(token))           { take(8); }

    return best;
}

function scoreAndFilter(all: XlfSearchEntry[], query: string): XlfSearchEntry[] {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);

    if (tokens.length === 0) {
        for (const e of all) { e.score = 0; }
        return [];
    }

    const scored: XlfSearchEntry[] = [];
    for (const e of all) {
        let total = 0;
        let allMatched = true;
        for (const token of tokens) {
            const s = scoreToken(e, token);
            if (s === 0) { allMatched = false; break; }
            total += s;
        }
        if (!allMatched) { continue; }
        e.score = Math.round(total / tokens.length);
        scored.push(e);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.length > MAX_RESULTS ? scored.slice(0, MAX_RESULTS) : scored;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function openEntry(entry: XlfSearchEntry): Promise<void> {
    const pkg = getPackageById(entry.pkgId);
    if (!pkg) {
        vscode.window.showWarningMessage('Source package is no longer loaded — try reloading packages.');
        return;
    }

    const obj = pkg.objects.find(o => o.type === entry.objType && o.id === entry.objId);
    if (!obj) {
        vscode.window.showWarningMessage(
            `Cannot find ${entry.objType} ${entry.objId} in the loaded package.`
        );
        return;
    }

    let line = obj.line;
    if (entry.memberNameOrig) {
        const el = obj.elements.find(e => e.name === entry.memberNameOrig);
        if (el) {
            line = el.line;
        } else {
            const fn = obj.functions.find(f => f.name === entry.memberNameOrig);
            if (fn) { line = fn.line; }
        }
    }

    await showAlObjectUsingPreviewScheme(obj, pkg, line);
}

// ---------------------------------------------------------------------------
// Eager index build (called after packages are loaded)
// ---------------------------------------------------------------------------

/**
 * Build (or refresh) the translation index in the background.
 * Called from extension.ts after reloadAllPackages() completes so the index is
 * ready before the user first invokes the search command.
 */
export async function buildTranslationIndex(): Promise<void> {
    try {
        await buildEntries();
    } catch (err) {
        logger.error('Failed to build translation search index', err);
        vscode.window.showWarningMessage(`AL Companion: Translation index build failed — ${err}`);
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function searchTranslationsCommand(): Promise<void> {
    let allEntries: XlfSearchEntry[];
    try {
        const currentVersion = getStoreVersion();
        const needsBuild = cachedEntries === null || cachedStoreVersion !== currentVersion;

        if (needsBuild) {
            allEntries = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Building translation search index\u2026',
                    cancellable: false,
                },
                () => buildEntries()
            );
        } else {
            allEntries = await buildEntries();
        }
    } catch (err) {
        logger.error('Translation search failed', err);
        vscode.window.showWarningMessage(`AL Companion: Translation search failed — ${err}`);
        return;
    }

    if (allEntries.length === 0) {
        vscode.window.showInformationMessage(
            'No translation entries found. Make sure your project contains .xlf files and packages are loaded.'
        );
        return;
    }

    const qp = vscode.window.createQuickPick<XlfSearchEntry>();
    qp.placeholder = `Search ${allEntries.length.toLocaleString()} translation entries\u2026 (e.g. "customer name caption")`;
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.items = [];  // start empty — populated as the user types

    const changeDisposable = qp.onDidChangeValue(value => {
        qp.items = scoreAndFilter(allEntries, value);
    });

    const acceptDisposable = qp.onDidAccept(async () => {
        const selected = qp.selectedItems[0];
        qp.hide();
        if (selected) {
            await openEntry(selected);
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
        vscode.commands.registerCommand('al-companion.searchTranslations', searchTranslationsCommand)
    );
}
