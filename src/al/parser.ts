import { AlObject, AlFunction, AlObjectType } from './types';
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
    /^\s*(table|tableextension|page|pageextension|codeunit|report|query|xmlport|enum|enumextension|interface|permissionset|permissionsetextension)\s+(\d+)\s+"?([^"\r\n{]+?)"?\s*(?:extends\s+"?([^"\r\n{]+?)"?)?\s*(?:\{|$)/i;

// ---------------------------------------------------------------------------
// Procedure / trigger regex
// ---------------------------------------------------------------------------

// Captures optional leading attribute lines and then the procedure line.
// We walk line-by-line rather than using one big regex so that line numbers
// stay exact even for files with Windows-style line endings.
const ATTRIBUTE_RE = /^\s*\[(.+)\]\s*$/;
const PROCEDURE_RE =
    /^\s*(local\s+|internal\s+)*(procedure|trigger)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;

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
        functions: [],
        eventSubscribers: [],
        extra: {},
    };

    // Walk lines collecting attributes + procedures
    const pendingAttributes: string[] = [];

    for (let i = objectLine + 1; i < lines.length; i++) {
        const line = lines[i];

        const attrMatch = line.match(ATTRIBUTE_RE);
        if (attrMatch) {
            pendingAttributes.push(attrMatch[1].trim());
            continue;
        }

        const procMatch = line.match(PROCEDURE_RE);
        if (procMatch) {
            const modifiers = (procMatch[1] ?? '').toLowerCase();
            const fnName = procMatch[3];
            const fn: AlFunction = {
                name: fnName,
                line: i + 1, // 1-based
                attributes: [...pendingAttributes],
                isLocal: modifiers.includes('local'),
                isInternal: modifiers.includes('internal'),
            };
            alObject.functions.push(fn);
            pendingAttributes.length = 0;
            continue;
        }

        // Any non-attribute, non-procedure line clears pending attributes
        if (line.trim() !== '') {
            pendingAttributes.length = 0;
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
