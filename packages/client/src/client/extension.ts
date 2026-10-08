import type {
    ClientCapabilities,
    ClientContext,
    ExtensionDependency,
    ExtensionRequirement,
    InferHandlerResult,
    JSONObject,
    RequestMethod,
    RequestMiddleware,
    StandardSchemaV1
} from '@modelcontextprotocol/core-internal';
import { extensionRequirementsCheck, setExtensionRequestHandler, uniqueExtensionIds } from '@modelcontextprotocol/core-internal';

import type { Client } from './client';

/**
 * A client extension: the client half of protocol behaviour outside the core
 * specification, such as the `io.modelcontextprotocol/tasks` extension or a
 * vendor feature, passed to the client at construction.
 *
 * ```ts
 * const client = new Client(info, { extensions: [tasks] });
 * ```
 *
 * What is both required and declarative sits on the object: the `id`.
 * Everything else happens in `setup`, which runs once while the client is
 * constructed: optional declarations first (`ctx.capability`, `ctx.require`),
 * then handlers for server-to-client requests, middleware, and the result
 * kinds it accepts.
 *
 * Experimental: the shape of an extension may change in a minor release.
 *
 * @experimental
 */
export interface ClientExtension {
    /**
     * The extension identifier, prefix-qualified (`io.modelcontextprotocol/tasks`,
     * `com.example/feature-flags`). Advertised as the key under the client's
     * `capabilities.extensions`, and unique per client.
     */
    readonly id: string;
    /** Adds the extension to the client. Called once, at construction, in `extensions` order. */
    setup(ctx: ClientExtensionContext): void;
}

/**
 * Something a client extension can depend on: a core capability the client
 * must declare (`'elicitation'`, `'sampling'`, …), or the id of another
 * extension the client must install.
 */
export type ClientExtensionDependency = ExtensionDependency<Exclude<keyof ClientCapabilities, 'experimental' | 'extensions'>>;

/** The core capabilities among the dependencies a client extension can declare. */
type ClientCoreCapability = Exclude<ClientExtensionDependency, `${string}/${string}`>;

/**
 * What a {@linkcode ClientExtension}'s `setup` receives.
 *
 * Experimental: this shape may change in a minor release.
 *
 * @experimental
 */
export interface ClientExtensionContext {
    /** The client the extension is set up on. */
    readonly client: Client;
    /**
     * Sets what the client advertises under `capabilities.extensions[id]`:
     * in `initialize` on a legacy connection, and in every request's
     * client-capabilities envelope on a 2026-07-28 connection. Without a call,
     * the client advertises `{}`.
     */
    capability(settings: JSONObject): void;
    /**
     * Declares a dependency: a core capability the client must declare, or
     * another extension it must install, wherever it is listed. Checked when
     * the client connects; `connect()` rejects, naming this extension and the
     * dependency, when one is missing.
     */
    require(dependency: ClientExtensionDependency): void;
    /** Middleware around whatever handler serves a server-to-client request `method`. See `Protocol.use`. */
    use(method: RequestMethod | (string & {}), middleware: RequestMiddleware<ClientContext>): void;
    /**
     * Registers the handler for a custom server-to-client request, like
     * `Client.setRequestHandler` with schemas, but checked: throws when `name`
     * is a core method (wrap those with `use` instead) or when a handler
     * already serves it, such as another extension's.
     */
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        name: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ClientContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    /**
     * Lets results of `method` carry a `resultType` this extension defines,
     * such as the Tasks extension's `"task"` on `tools/call`. See
     * `Protocol.acceptResultType`.
     */
    acceptResultType(method: string, resultType: string): void;
}

/**
 * Sets up `extensions` on `client`, in order, and returns the dependency check
 * `Client.connect` runs against the client's capabilities. Ids are checked
 * before anything is set up, so a duplicate leaves the client untouched. A
 * `setup` that throws fails the `Client` constructor that called this.
 *
 * Package-internal: called by the `Client` constructor.
 */
export function installClientExtensions(
    client: Client,
    extensions: readonly ClientExtension[]
): (capabilities: ClientCapabilities) => void {
    const ids = uniqueExtensionIds(extensions);
    for (const extension of extensions) {
        if (typeof extension.setup !== 'function') {
            throw new TypeError(`Extension "${String((extension as { id: unknown }).id)}" has no setup`);
        }
    }

    const requirements: ExtensionRequirement<ClientCoreCapability>[] = [];
    for (const extension of extensions) {
        client.registerCapabilities({ extensions: { [extension.id]: {} } });
        extension.setup(contextFor(client, extension.id, requirements));
    }

    return extensionRequirementsCheck('client', ids, requirements);
}

/** The context one extension's `setup` receives; everything it registers is attributed to `id`. */
function contextFor(client: Client, id: string, requirements: ExtensionRequirement<ClientCoreCapability>[]): ClientExtensionContext {
    return {
        client,
        capability(settings) {
            client.registerCapabilities({ extensions: { [id]: settings } });
        },
        require(dependency) {
            requirements.push({ extension: id, dependency });
        },
        use(method, middleware) {
            client.use(method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(client, id, name, schemas, handler);
        },
        acceptResultType(method, resultType) {
            client.acceptResultType(method, resultType);
        }
    };
}
