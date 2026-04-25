import { AlObject, AlFunction, AlElement, AlObjectType } from './types';
import * as logger from './logger';

/**
 * A parser plugin receives the full source text of one AL file and the
 * partially-constructed AlObject.  It may mutate the object or add data
 * to `object.extra`.  Return true when something was modified.
 */
export type AlParserPlugin = (source: string, object: AlObject) => boolean;

const plugins: AlParserPlugin[] = [];

/**
 * Register an additional parser plugin.  Plugins are called in registration
 * order after the built-in function / event-subscriber parser has run.
 */
export function registerPlugin(plugin: AlParserPlugin): void {
    plugins.push(plugin);
}

// ---------------------------------------------------------------------------
// Object-header regex
// ---------------------------------------------------------------------------

// Matches:  table 50100 "My Table"
//           table 50100 "My Table" {
//           tableextension 50200 "My Ext" extends "My Table"
//           codeunit 50300 MyCU
// The opening brace is optional – it may appear on the next line in AL source.
const OBJECT_HEADER_RE =
    /^\s*(table|tableextension|page|pageextension|codeunit|report|reportextension|query|xmlport|enum|enumextension|interface|permissionset|permissionsetextension)\s+(\d+)\s+"?([^"\r\n{]+?)"?\s*(?:extends\s+"?([^"\r\n{]+?)"?)?\s*(?:\{|$)/i;

// ---------------------------------------------------------------------------
// Procedure / trigger regex
// ---------------------------------------------------------------------------

// Captures optional leading attribute lines and then the procedure line.
// We walk line-by-line rather than using one big regex so that line numbers
// stay exact even for files with Windows-style line endings.
const PROCEDURE_RE =
    /^\s*(local\s+|internal\s+)*(procedure|trigger)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;

// ---------------------------------------------------------------------------
// Element regexes (fields, actions, enum values, columns)
// ---------------------------------------------------------------------------

// Table / enum fields:   field(3; "Name 3"; Text[50])  or  field(3; Name3; Text[50])
const TABLE_FIELD_RE = /^\s*field\s*\(\s*(\d+)\s*;\s*"?([^";\/\r\n]+?)"?\s*;/i;

// Page / extension field controls:  field("Control Name"; Rec."Field")  or  field(CtrlName; ...)
// Only matches when first arg is NOT a plain number (avoids overlap with TABLE_FIELD_RE).
const PAGE_FIELD_RE = /^\s*field\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_\s]*?))\s*;/i;

// Page actions:   action("Action Name")  or  action(ActionName)
const ACTION_RE = /^\s*action\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\)/i;

// Enum values:   value(0; "Some Value")  or  value(0; SomeValue)
const ENUM_VALUE_RE = /^\s*value\s*\(\s*(\d+)\s*;\s*"?([^";\/\r\n)]+?)"?\s*\)/i;

// Report / query columns:   column(ColumnName; Source)  or  column("Name"; Source)
const COLUMN_RE = /^\s*column\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*;/i;

// Caption property:   Caption = 'My Caption';   Caption = 'My Caption', Locked = true;
const CAPTION_RE = /^\s*Caption\s*=\s*'([^']*)'/i;

// ---------------------------------------------------------------------------
// Brace counting (excludes braces inside string literals)
// ---------------------------------------------------------------------------

function countBraces(line: string): { opens: number; closes: number } {
    let inSingle = false;
    let inDouble = false;
    let opens = 0;
    let closes = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble)      { inSingle = !inSingle; }
        else if (ch === '"' && !inSingle) { inDouble  = !inDouble; }
        else if (!inSingle && !inDouble)  {
            if (ch === '{') { opens++; }
            else if (ch === '}') { closes++; }
        }
    }
    return { opens, closes };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single AL source file.  Returns the parsed AlObject, or undefined
 * when the file does not contain a recognisable AL object header.
 */
export function parseAlSource(source: string, fileName: string): AlObject | undefined {
    const lines = source.split(/\r?\n/);

    // Find object header
    let objectLine = -1;
    let headerMatch: RegExpMatchArray | null = null;
    for (let i = 0; i < lines.length; i++) {
        headerMatch = lines[i].match(OBJECT_HEADER_RE);
        if (headerMatch) {
            objectLine = i;
            break;
        }
    }

    if (!headerMatch || objectLine < 0) {
        logger.debug(`No object header found in ${fileName}`);
        return undefined;
    }

    const rawType = headerMatch[1].toLowerCase();
    const objectType = mapObjectType(rawType);
    const objectId = parseInt(headerMatch[2], 10);
    const objectName = headerMatch[3].trim();
    const extendsName = headerMatch[4]?.trim();

    const alObject: AlObject = {
        type: objectType,
        id: objectId,
        name: objectName,
        extendsName,
        line: objectLine + 1,
        functions: [],
        eventSubscribers: [],
        elements: [],
        extra: {},
    };

    // ── Depth + caption tracking ─────────────────────────────────────────────
    // depth = 0 before the object body; rises to 1 on the first opening brace.
    // captionTargets[depth] = item that owns a Caption statement at that depth.
    const { opens: headerOpens } = countBraces(lines[objectLine]);
    let depth = headerOpens > 0 ? 1 : 0;
    const captionTargets = new Map<number, { caption?: string }>();
    let pendingCaptionItem: { caption?: string } | null = null;
    if (depth >= 1) {
        captionTargets.set(1, alObject);
    } else {
        pendingCaptionItem = alObject;
    }

    const pendingAttributes: string[] = [];
    // Accumulates attribute text across multiple lines until brackets balance.
    let pendingAttrBuffer = '';

    for (let i = objectLine + 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') { continue; }

        const { opens, closes } = countBraces(line);

        // ── Step 1: detect content BEFORE updating depth ──────────────────────
        // Handle both single-line and multi-line [Attribute(...)] declarations.
        if (pendingAttrBuffer.length > 0 || trimmed.startsWith('[')) {
            pendingAttrBuffer += (pendingAttrBuffer.length > 0 ? ' ' : '') + trimmed;
            // Count bracket balance; the attribute is complete once all '[' are matched.
            let balance = 0;
            for (const ch of pendingAttrBuffer) {
                if (ch === '[') { balance++; }
                else if (ch === ']') { balance--; }
            }
            if (balance <= 0) {
                const m = pendingAttrBuffer.match(/^\s*\[(.+)\]\s*$/);
                if (m) { pendingAttributes.push(m[1].trim()); }
                pendingAttrBuffer = '';
            }
        } else {
            let elementFound = false;

            const procMatch = line.match(PROCEDURE_RE);
            if (procMatch) {
                const modifiers = (procMatch[1] ?? '').toLowerCase();
                const fn: AlFunction = {
                    name: procMatch[3],
                    line: i + 1,
                    attributes: [...pendingAttributes],
                    isLocal: modifiers.includes('local'),
                    isInternal: modifiers.includes('internal'),
                    isTrigger: procMatch[2].toLowerCase() === 'trigger',
                };
                alObject.functions.push(fn);
                pendingCaptionItem = fn;
                pendingAttributes.length = 0;
                elementFound = true;
            }

            if (!elementFound && !trimmed.startsWith('//')) {
                const tableFieldMatch = line.match(TABLE_FIELD_RE);
                if (tableFieldMatch) {
                    const el: AlElement = {
                        kind: 'field', id: parseInt(tableFieldMatch[1], 10),
                        name: tableFieldMatch[2].trim(), line: i + 1,
                    };
                    alObject.elements.push(el);
                    pendingCaptionItem = el;
                    elementFound = true;
                }
            }

            if (!elementFound && !trimmed.startsWith('//')) {
                const actionMatch = line.match(ACTION_RE);
                if (actionMatch) {
                    const el: AlElement = {
                        kind: 'action',
                        name: (actionMatch[1] ?? actionMatch[2]).trim(), line: i + 1,
                    };
                    alObject.elements.push(el);
                    pendingCaptionItem = el;
                    elementFound = true;
                }
            }

            if (!elementFound && !trimmed.startsWith('//')) {
                const enumValueMatch = line.match(ENUM_VALUE_RE);
                if (enumValueMatch) {
                    const el: AlElement = {
                        kind: 'enumValue', id: parseInt(enumValueMatch[1], 10),
                        name: enumValueMatch[2].trim(), line: i + 1,
                    };
                    alObject.elements.push(el);
                    pendingCaptionItem = el;
                    elementFound = true;
                }
            }

            if (!elementFound && !trimmed.startsWith('//')) {
                const columnMatch = line.match(COLUMN_RE);
                if (columnMatch) {
                    const el: AlElement = {
                        kind: 'column',
                        name: (columnMatch[1] ?? columnMatch[2]).trim(), line: i + 1,
                    };
                    alObject.elements.push(el);
                    pendingCaptionItem = el;
                    elementFound = true;
                }
            }

            if (!elementFound && !trimmed.startsWith('//')) {
                const pageFieldMatch = line.match(PAGE_FIELD_RE);
                if (pageFieldMatch) {
                    const el: AlElement = {
                        kind: 'field',
                        name: (pageFieldMatch[1] ?? pageFieldMatch[2]).trim(), line: i + 1,
                    };
                    alObject.elements.push(el);
                    pendingCaptionItem = el;
                    elementFound = true;
                }
            }

            if (!elementFound) {
                pendingAttributes.length = 0;
            }
        }

        // ── Step 2: apply opening braces ──────────────────────────────────────
        for (let b = 0; b < opens; b++) {
            depth++;
            if (pendingCaptionItem) {
                captionTargets.set(depth, pendingCaptionItem);
                pendingCaptionItem = null;
            }
        }

        // ── Step 3: detect Caption at current depth ────────────────────────────
        const captionMatch = line.match(CAPTION_RE);
        if (captionMatch) {
            const target = captionTargets.get(depth);
            if (target && target.caption === undefined) {
                target.caption = captionMatch[1];
            }
        }

        // ── Step 4: apply closing braces ──────────────────────────────────────
        for (let b = 0; b < closes; b++) {
            captionTargets.delete(depth);
            depth--;
        }
    }

    // Run additional plugins
    if (plugins.length > 0) {
        for (const plugin of plugins) {
            try {
                plugin(source, alObject);
            } catch (err) {
                logger.error(`Plugin error while parsing ${fileName}`, err);
            }
        }
    }

    return alObject;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OBJECT_TYPE_MAP: Record<string, AlObjectType> = {
    table: 'Table',
    tableextension: 'TableExtension',
    page: 'Page',
    pageextension: 'PageExtension',
    codeunit: 'Codeunit',
    report: 'Report',
    reportextension: 'ReportExtension',
    query: 'Query',
    xmlport: 'XmlPort',
    enum: 'Enum',
    enumextension: 'EnumExtension',
    interface: 'Interface',
    permissionset: 'PermissionSet',
    permissionsetextension: 'PermissionSetExtension',
};

function mapObjectType(raw: string): AlObjectType {
    return OBJECT_TYPE_MAP[raw] ?? 'Unknown';
}
