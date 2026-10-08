/**
 * The rules server and client extensions share: unique ids, checked request
 * handler registration, and dependency checks. `McpServer` and `Client` set
 * extensions up with these, so both sides refuse the same things with the
 * same messages.
 */
import type { StandardSchemaV1 } from '../util/standardSchema';
import { codecForVersion, MODERN_WIRE_REVISION } from '../wire/codec';
import type { BaseContext, InferHandlerResult, Protocol } from './protocol';

/**
 * Something an extension can depend on: a core capability `C` the local side
 * must declare, or another extension's id. Extension ids are always
 * `{vendor-prefix}/{name}` (SEP-2133), so they contain a `/`, and capability
 * names never do.
 */
export type ExtensionDependency<C extends string> = C | `${string}/${string}`;

/** One extension's dependency, recorded while it is set up and checked when the side connects. */
export interface ExtensionRequirement<C extends string> {
    /** The id of the extension that declared the dependency. */
    readonly extension: string;
    /** What it depends on. */
    readonly dependency: ExtensionDependency<C>;
}

const isExtensionId = <C extends string>(dependency: ExtensionDependency<C>): dependency is `${string}/${string}` =>
    dependency.includes('/');

/**
 * Returns the extensions' ids, or throws when two share one. Runs before any
 * extension is set up, so a duplicate leaves the server or client untouched.
 */
export function uniqueExtensionIds(extensions: readonly { readonly id: string }[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const { id } of extensions) {
        if (ids.has(id)) throw new Error(`Extension "${id}" is listed more than once; pass each extension once`);
        ids.add(id);
    }
    return ids;
}

/**
 * Builds the check `connect` runs: it throws, naming the extension and the
 * dependency, for the first requirement the local side lacks. `installed` is
 * every extension id on that side, wherever it was listed.
 */
export function extensionRequirementsCheck<C extends string>(
    side: 'server' | 'client',
    installed: ReadonlySet<string>,
    requirements: readonly ExtensionRequirement<C>[]
): (capabilities: Readonly<Partial<Record<C, unknown>>>) => void {
    return capabilities => {
        for (const { extension, dependency } of requirements) {
            if (isExtensionId(dependency)) {
                if (!installed.has(dependency)) {
                    throw new Error(`Extension "${extension}" requires the "${dependency}" extension, which this ${side} does not install`);
                }
            } else if (capabilities[dependency] === undefined) {
                throw new Error(`Extension "${extension}" requires the "${dependency}" capability, which this ${side} does not declare`);
            }
        }
    };
}

/**
 * `setRequestHandler` on the extension path. It refuses a 2026-07-28 core
 * method name, which an extension wraps with `use` instead, and a method that
 * already has a handler, such as another extension's.
 */
export function setExtensionRequestHandler<
    ContextT extends BaseContext,
    P extends StandardSchemaV1,
    R extends StandardSchemaV1 | undefined = undefined
>(
    protocol: Protocol<ContextT>,
    extension: string,
    name: string,
    schemas: { params: P; result?: R },
    handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
): void {
    if (codecForVersion(MODERN_WIRE_REVISION).hasRequestMethod(name)) {
        throw new Error(`Extension "${extension}" cannot register "${name}": it is a core method; wrap it with use() instead`);
    }
    try {
        protocol.assertCanSetRequestHandler(name);
    } catch {
        throw new Error(`Extension "${extension}" cannot register "${name}": another handler already serves it`);
    }
    protocol.setRequestHandler(name, schemas, handler);
}
