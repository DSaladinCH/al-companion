/**
 * Core AL symbol types used throughout the extension.
 * The model is intentionally open so additional parsers can extend it later.
 */

export type AlObjectType =
    | 'Table'
    | 'TableExtension'
    | 'Page'
    | 'PageExtension'
    | 'Codeunit'
    | 'Report'
    | 'Query'
    | 'XmlPort'
    | 'Enum'
    | 'EnumExtension'
    | 'Interface'
    | 'PermissionSet'
    | 'PermissionSetExtension'
    | 'Unknown';

/** Represents a single procedure / trigger parsed from an AL object. */
export interface AlFunction {
    name: string;
    /** Line number inside the source file (1-based). */
    line: number;
    /** Raw attribute lines above the function, e.g. [EventSubscriber(...)]. */
    attributes: string[];
    /** True when the function is marked local. */
    isLocal: boolean;
    /** True when the function is marked internal. */
    isInternal: boolean;
}

/** Represents a parsed event-subscriber decoration. */
export interface AlEventSubscriber {
    /** The function that carries the [EventSubscriber(...)] attribute. */
    fn: AlFunction;
    /** Object type that publishes the event, e.g. 'Codeunit'. */
    publisherObjectType: string;
    /** Object name/id that publishes the event. */
    publisherObjectName: string;
    /** Name of the event procedure on the publisher object. */
    eventName: string;
    /** Optional element (field/action) the subscriber targets – only relevant for table/page events. */
    elementName: string;
}

/** Represents a single AL object (table, codeunit, etc.) inside a package. */
export interface AlObject {
    type: AlObjectType;
    id: number;
    name: string;
    /** For *Extension objects – the object being extended. */
    extendsName?: string;
    functions: AlFunction[];
    eventSubscribers: AlEventSubscriber[];
    /** Arbitrary extra data added by additional parsers. */
    extra: Record<string, unknown>;
}

/** Represents a parsed AL package (.app file). */
export interface AlPackage {
    /** Unique identifier: "<publisher>_<name>_<version>" */
    id: string;
    publisher: string;
    name: string;
    version: string;
    /** Absolute path of the .app file. */
    filePath: string;
    objects: AlObject[];
}
