import { AlObject, AlPackage } from './types';

/**
 * An object processor is called once per object during package loading.
 * Each processor can build its own indexes, caches, or data structures.
 *
 * By using a single pass through all objects, we avoid multiple full iterations
 * across potentially thousands of objects (e.g., Base Application has 9k+ objects).
 *
 * Instead of: plugin1 scan all objects, then plugin2 scan all objects, then plugin3...
 * We do: for each object, let plugin1 process, plugin2 process, plugin3 process
 *
 * This reduces O(n³) nested loops to O(n × p) where p = number of processors.
 *
 * Processors run in registration order after all packages are loaded into the store.
 * They are NOT run on incremental file updates (reloadLocalFile); each processor
 * must handle cache invalidation via storeVersion.
 */
export interface ObjectProcessor {
    /** Unique identifier for the processor (e.g., "event-subscriber-indexer"). */
    id: string;
    /**
     * Called once per object during reloadAllPackages().
     * The processor receives the object and its owning package and can build
     * indexes, validate data, or accumulate statistics.
     */
    process(obj: AlObject, pkg: AlPackage): void;
}

const processors: ObjectProcessor[] = [];

/**
 * Register a processor to be called during the single-pass object iteration.
 * Call at module load time (before any reloadAllPackages invocation).
 */
export function registerObjectProcessor(processor: ObjectProcessor): void {
    processors.push(processor);
}

/**
 * Run all registered processors on all objects in all packages.
 * Called from packageStore after packages are fully loaded.
 *
 * Single iteration: O(packages × objects × processors) instead of
 * O(packages × objects) for each plugin that needs to scan independently.
 *
 * IMPORTANT: This is a single-pass sequential iteration. Parallelism at the
 * object level is not beneficial in Node.js (single-threaded) and would add
 * overhead. The real parallelism happens earlier in reloadAllPackages() when
 * loading .app files and parsing .al files from disk (steps 3-4).
 *
 * The processor phase is typically <10ms for 9000+ objects. The reload time
 * is dominated by disk I/O and parsing, not the processor loop.
 */
export async function processAllObjects(packages: AlPackage[]): Promise<void> {
    let totalObjects = 0;
    const startTime = performance.now();

    for (const pkg of packages) {
        for (const obj of pkg.objects) {
            totalObjects++;
            for (const processor of processors) {
                processor.process(obj, pkg);
            }
        }
    }

    const elapsed = (performance.now() - startTime).toFixed(0);
    console.log(
        `[ObjectProcessor] Single-pass processed ${totalObjects} objects across ${processors.length} ` +
        `processor(s) in ${elapsed}ms`
    );
}
