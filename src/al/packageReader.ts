import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { AlPackage, AlObject, AlAppManifest } from './types';
import { parseAlSource } from './parser';
import * as logger from './logger';

/**
 * Read only the manifest metadata (publisher, name, version, id) from a .app
 * file without parsing any AL source.  Used for fast pre-filtering before
 * deciding which packages to fully load.
 */
export async function readAppManifest(filePath: string): Promise<AlAppManifest | undefined> {
    let rawBuffer: Buffer;
    try {
        rawBuffer = fs.readFileSync(filePath);
    } catch (err) {
        logger.error(`Cannot read file ${filePath}`, err);
        return undefined;
    }

    const zipBuffer = findZipStart(rawBuffer);
    if (!zipBuffer) {
        logger.error(`No ZIP signature found in ${filePath}`);
        return undefined;
    }

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(zipBuffer);
    } catch (err) {
        logger.error(`Cannot parse ZIP in ${filePath}`, err);
        return undefined;
    }

    let publisher = 'Unknown';
    let name = path.basename(filePath, '.app');
    let version = '0.0.0.0';
    let id: string | undefined;

    const appJsonFile = zip.file('app.json');
    if (appJsonFile) {
        try {
            const json = JSON.parse(await appJsonFile.async('string'));
            publisher = json.publisher ?? publisher;
            name = json.name ?? name;
            version = json.version ?? version;
            id = json.id;
        } catch (err) {
            logger.error(`Cannot parse app.json in ${filePath}`, err);
        }
    } else {
        const manifestFile = zip.file('NavxManifest.xml');
        if (manifestFile) {
            try {
                const xml = await manifestFile.async('string');
                const pubMatch = xml.match(/Publisher\s*=\s*"([^"]+)"/i);
                const nameMatch = xml.match(/(?:^|<)App[^>]+\s+Name\s*=\s*"([^"]+)"/i);
                const verMatch = xml.match(/Version\s*=\s*"([^"]+)"/i);
                const idMatch = xml.match(/Id\s*=\s*"([^"]+)"/i);
                if (pubMatch) { publisher = pubMatch[1]; }
                if (nameMatch) { name = nameMatch[1]; }
                if (verMatch) { version = verMatch[1]; }
                if (idMatch) { id = idMatch[1]; }
            } catch (err) {
                logger.error(`Cannot parse NavxManifest.xml in ${filePath}`, err);
            }
        }
    }

    return { id, publisher, name, version, filePath };
}

/**
 * Read a single .app file and return its parsed AlPackage, or undefined on error.
 *
 * AL .app files are ZIP archives.  Inside the ZIP there may be:
 *  - A NavxManifest.xml (older format)
 *  - An app.json (newer format)
 *  - AL source files under src/ or directly in the root
 *
 * Sometimes the archive is prefixed with a few "magic" bytes that are not
 * part of the ZIP stream.  We probe for the PK header and strip any leading
 * garbage before handing the buffer to JSZip.
 */
export async function readAppFile(filePath: string): Promise<AlPackage | undefined> {
    logger.debug(`Reading package: ${filePath}`);

    let rawBuffer: Buffer;
    try {
        rawBuffer = fs.readFileSync(filePath);
    } catch (err) {
        logger.error(`Cannot read file ${filePath}`, err);
        return undefined;
    }

    // AL .app files sometimes have a 40-byte header before the actual ZIP data.
    // Find the PK signature (0x50 0x4B 0x03 0x04) to locate the ZIP start.
    const zipBuffer = findZipStart(rawBuffer);
    if (!zipBuffer) {
        logger.error(`No ZIP signature found in ${filePath}`);
        return undefined;
    }

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(zipBuffer);
    } catch (err) {
        logger.error(`Cannot parse ZIP in ${filePath}`, err);
        return undefined;
    }

    // ── Determine package identity ──────────────────────────────────────────
    let publisher = 'Unknown';
    let name = path.basename(filePath, '.app');
    let version = '0.0.0.0';

    const appJsonFile = zip.file('app.json');
    if (appJsonFile) {
        try {
            const json = JSON.parse(await appJsonFile.async('string'));
            publisher = json.publisher ?? publisher;
            name = json.name ?? name;
            version = json.version ?? version;
        } catch (err) {
            logger.error(`Cannot parse app.json in ${filePath}`, err);
        }
    } else {
        // Try NavxManifest.xml
        const manifestFile = zip.file('NavxManifest.xml');
        if (manifestFile) {
            try {
                const xml = await manifestFile.async('string');
                const pubMatch = xml.match(/Publisher\s*=\s*"([^"]+)"/i);
                const nameMatch = xml.match(/(?:^|<)App[^>]+\s+Name\s*=\s*"([^"]+)"/i);
                const verMatch = xml.match(/Version\s*=\s*"([^"]+)"/i);
                if (pubMatch) { publisher = pubMatch[1]; }
                if (nameMatch) { name = nameMatch[1]; }
                if (verMatch) { version = verMatch[1]; }
            } catch (err) {
                logger.error(`Cannot parse NavxManifest.xml in ${filePath}`, err);
            }
        }
    }

    const packageId = `${publisher}_${name}_${version}`.replace(/\s+/g, '_');

    // ── Parse AL source files ────────────────────────────────────────────────
    const objects: AlObject[] = [];
    const alFiles = Object.values(zip.files).filter(
        f => !f.dir && f.name.toLowerCase().endsWith('.al')
    );

    for (const alFile of alFiles) {
        let source: string;
        try {
            // AL sources can be UTF-8 with or without BOM
            const buffer = await alFile.async('nodebuffer');
            source = buffer.toString('utf8').replace(/^\uFEFF/, '');
        } catch (err) {
            logger.error(`Cannot read AL file ${alFile.name} in ${filePath}`, err);
            continue;
        }

        const obj = parseAlSource(source, alFile.name);
        if (obj) {
            objects.push(obj);
        }
    }

    logger.debug(`Parsed ${objects.length} objects from ${filePath}`);

    return {
        id: packageId,
        publisher,
        name,
        version,
        filePath,
        objects,
    };
}

/**
 * Locate the start of the ZIP data inside a buffer.
 * AL .app files sometimes have a vendor-specific header prefixed before the
 * actual ZIP stream.  We scan for the local-file-header signature PK\x03\x04.
 */
function findZipStart(buf: Buffer): Buffer | undefined {
    // Fast path: starts right at offset 0
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
        return buf;
    }

    // The Microsoft AL runtime uses a 40-byte magic header before the ZIP.
    // When we can't find it at 0, scan the first 256 bytes.
    const SEARCH_LIMIT = Math.min(buf.length, 256);
    for (let i = 1; i < SEARCH_LIMIT - 3; i++) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
            return buf.slice(i);
        }
    }

    return undefined;
}
