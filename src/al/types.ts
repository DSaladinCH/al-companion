/**
 * Core AL symbol types used throughout the extension.
 * The model is intentionally open so additional parsers can extend it later.
 */

/** Manifest identity read from inside a .app ZIP (fast, no AL source parsing). */
export interface AlAppManifest {
    /** GUID as declared in app.json / NavxManifest.xml – may be undefined for very old packages. */
    id: string | undefined;
    publisher: string;
    name: string;
    version: string;
    filePath: string;
}

/** A single entry from the `dependencies` array in a project's app.json. */
export interface AlAppJsonDependency {
    /** GUID of the dependency. */
    id?: string;
    publisher: string;
    name: string;
    /** Minimum required version, e.g. "20.0.0.0". */
    version: string;
}

export type AlObjectType =
    | 'Table'
    | 'TableExtension'
    | 'Page'
    | 'PageExtension'
    | 'Codeunit'
    | 'Report'
    | 'ReportExtension'
    | 'Query'
    | 'XmlPort'
    | 'Enum'
    | 'EnumExtension'
    | 'Interface'
    | 'PermissionSet'
    | 'PermissionSetExtension'
    | 'Profile'
    | 'ProfileExtension'
    | 'Entitlement'
    | 'ControlAddin'
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
    /** True when this is a trigger (e.g. OnValidate) rather than a developer procedure. */
    isTrigger: boolean;
    /** Parsed Caption property of the function/trigger, if declared. */
    caption?: string;
}

/** Kind of a non-function AL member (field, action, enum value, etc.). */
export type AlElementKind = 'field' | 'action' | 'enumValue' | 'column';

/** A non-function member inside an AL object (table field, page action, enum value, …). */
export interface AlElement {
    kind: AlElementKind;
    /** Numeric ID for table fields and enum values. */
    id?: number;
    name: string;
    /** Line number inside the source file (1-based). */
    line: number;
    /** Parsed Caption property of the element, if declared. */
    caption?: string;
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
    /** Line number of the object header in the source file (1-based). */
    line: number;
    /** Parsed Caption property of the object, if declared. */
    caption?: string;
    /** For *Extension objects – the object being extended. */
    extendsName?: string;
    /** For Codeunit/Enum objects – comma-separated list of interfaces being implemented. */
    implementsNames?: string[];
    /** For Page objects – the SourceTable property value. */
    sourceTable?: string;
    /** Namespace declared at the top of the source file, e.g. "MyCompany.MyApp". */
    namespace?: string;
    /** Using directives declared at the top of the source file. */
    usings?: string[];
    functions: AlFunction[];
    eventSubscribers: AlEventSubscriber[];
    /** Parsed non-function members: table fields, page field controls, actions, enum values, etc. */
    elements: AlElement[];
    /** Absolute path of the .al source file – only set for local workspace objects. */
    sourceFilePath?: string;
    /** Path of the .al entry inside the .app ZIP – only set for package objects. */
    zipEntryName?: string;
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
    /** Real app GUID from app.json or NavxManifest.xml (if available). */
    appId?: string;
    objects: AlObject[];
}
