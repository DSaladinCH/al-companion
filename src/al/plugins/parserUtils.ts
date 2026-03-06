import { AlFunction } from '../types';

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Find the raw content of the first attribute on `fn` whose name matches
 * `name` (case-insensitive).
 *
 * AL attribute lines like `[EventSubscriber(...)]` are stored by the core
 * parser as the content inside the brackets — e.g. `"EventSubscriber(..."`.
 * Pass just the attribute name (without parentheses) to locate it.
 *
 * Returns the full attribute string (name + arguments) or `undefined` when
 * none of the function's attributes start with `name`.
 *
 * @example
 * findAttribute(fn, 'EventSubscriber')
 * // → "EventSubscriber(ObjectType::Codeunit, Codeunit::\"Sales-Post\", ...)"
 */
export function findAttribute(fn: AlFunction, name: string): string | undefined {
    const prefix = name.toLowerCase();
    for (const attr of fn.attributes) {
        const lower = attr.toLowerCase();
        if (lower.startsWith(prefix) && (lower.length === prefix.length || lower[prefix.length] === '(')) {
            return attr;
        }
    }
    return undefined;
}

/**
 * Returns true when `fn` has at least one attribute with the given name.
 */
export function hasAttribute(fn: AlFunction, name: string): boolean {
    return findAttribute(fn, name) !== undefined;
}

/**
 * Split the argument list of an attribute string into individual argument
 * strings, respecting double-quoted strings, single-quoted strings, and
 * nested parentheses.
 *
 * Input:  `'EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", \'OnBefore\', \'\', true, true)'`
 * Output: `['ObjectType::Codeunit', 'Codeunit::"Sales-Post"', "'OnBefore'", "''", 'true', 'true']`
 *
 * Returns an empty array when the attribute has no argument list.
 */
export function parseAttributeArgs(attr: string): string[] {
    const parenStart = attr.indexOf('(');
    if (parenStart < 0) { return []; }

    // Strip the outer parens; handle missing closing paren gracefully
    const parenEnd = attr.lastIndexOf(')');
    const inner = attr.slice(parenStart + 1, parenEnd >= 0 ? parenEnd : undefined);
    if (!inner.trim()) { return []; }

    const args: string[] = [];
    let cur = '';
    let depth = 0;
    let inDouble = false;
    let inSingle = false;

    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (!inDouble && !inSingle) {
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            else if (ch === ',' && depth === 0) {
                args.push(cur.trim());
                cur = '';
                continue;
            }
        }
        cur += ch;
    }
    if (cur.trim()) { args.push(cur.trim()); }
    return args;
}

/**
 * Strip surrounding single or double quotes from a string argument.
 *
 * `unquote('"Sales Header"')` → `'Sales Header'`
 * `unquote("'OnBefore'")` → `'OnBefore'`
 * `unquote('MyCodeunit')` → `'MyCodeunit'`
 */
export function unquote(value: string): string {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}
