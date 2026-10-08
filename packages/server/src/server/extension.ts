import type {
    ExtensionDependency,
    ExtensionRequirement,
    InferHandlerResult,
    JSONObject,
    RequestMethod,
    RequestMiddleware,
    ServerCapabilities,
    ServerContext,
    StandardSchemaV1
} from '@modelcontextprotocol/core-internal';
import { extensionRequirementsCheck, setExtensionRequestHandler, uniqueExtensionIds } from '@modelcontextprotocol/core-internal';

import type { McpServer } from './mcp';

/**
 * A server extension: protocol behaviour outside the core specification,
 * such as the `io.modelcontextprotocol/tasks` extension or a vendor feature,
 * passed to the server at construction.
 *
 * ```ts
 * const server = new McpServer(info, { extensions: [tasks, skills] });
 * ```
 *
 * What is both required and declarative sits on the object: the `id`.
 * Everything else happens in `setup`, which runs once while the server is
 * constructed: optional declarations first (`ctx.capability`, `ctx.require`),
 * then custom request handlers, middleware on spec methods, and anything
 * registered on the `McpServer` itself, such as resources and tools.
 *
 * Experimental: the shape of an extension may change in a minor release.
 *
 * @experimental
 */
export interface ServerExtension {
    /**
     * The extension identifier, prefix-qualified (`io.modelcontextprotocol/tasks`,
     * `com.example/feature-flags`). Advertised as the key under
     * `capabilities.extensions`, and unique per server.
     */
    readonly id: string;
    /** Adds the extension to the server. Called once, at construction, in `extensions` order. */
    setup(ctx: ServerExtensionContext): void;
}

/**
 * Something a server extension can depend on: a core capability the server
 * must declare (`'tools'`, `'resources'`, …), or the id of another extension
 * the server must install.
 */
export type ServerExtensionDependency = ExtensionDependency<Exclude<keyof ServerCapabilities, 'experimental' | 'extensions'>>;

/** The core capabilities among the dependencies a server extension can declare. */
type ServerCoreCapability = Exclude<ServerExtensionDependency, `${string}/${string}`>;

/**
 * What a {@linkcode ServerExtension}'s `setup` receives.
 *
 * Experimental: this shape may change in a minor release.
 *
 * @experimental
 */
export interface ServerExtensionContext {
    /** The server the extension is set up on: `registerTool`, `registerResource`, `ResourceTemplate`. */
    readonly mcp: McpServer;
    /**
     * Sets what the server advertises under `capabilities.extensions[id]`.
     * Without a call, the server advertises `{}`.
     */
    capability(settings: JSONObject): void;
    /**
     * Declares a dependency: a core capability the server must declare, or
     * another extension it must install. Checked when the server connects, so
     * capabilities `McpServer` turns on later (at the first `registerTool`,
     * say) still count, and so does an extension listed after this one.
     * `connect()` rejects, naming this extension and the dependency, when one
     * is missing.
     */
    require(dependency: ServerExtensionDependency): void;
    /**
     * Middleware around whatever handler serves `method`, including a core
     * method or another extension's: it may answer, transform or refuse. Runs
     * outside middleware the application adds later with `server.use`, and
     * inside middleware from extensions earlier in `extensions`. See
     * `Protocol.use` for how middleware composes.
     */
    use(method: RequestMethod | (string & {}), middleware: RequestMiddleware<ServerContext>): void;
    /**
     * Registers the handler for a custom request method, like
     * `Server.setRequestHandler` with schemas, but checked: throws when `name`
     * is a core method (wrap those with `use` instead) or when a handler
     * already serves it, such as another extension's.
     */
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        name: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ServerContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
}

/**
 * What `McpServerOptions.extensions` accepts: a {@linkcode ServerExtension},
 * or an object with an `id` and `attach(mcp)`, the shape the Skills extension
 * ships with, which the server calls with itself in place of `setup`.
 */
export type ServerExtensionLike = ServerExtension | { readonly id: string; attach(mcp: McpServer): void };

/**
 * Sets up `extensions` on `mcp`, in order, and returns the dependency check
 * `McpServer.connect` runs. Ids are checked before anything is set up, so a
 * duplicate leaves the server untouched. A `setup` that throws fails the
 * `McpServer` constructor that called this, so a server with a partly set up
 * extension never exists.
 *
 * Package-internal: called by the `McpServer` constructor.
 */
export function installServerExtensions(mcp: McpServer, extensions: readonly ServerExtensionLike[]): () => void {
    const ids = uniqueExtensionIds(extensions);
    for (const extension of extensions) {
        if (!('setup' in extension) && !('attach' in extension)) {
            throw new TypeError(`Extension "${String((extension as { id: unknown }).id)}" has no setup`);
        }
    }

    const server = mcp.server;
    const requirements: ExtensionRequirement<ServerCoreCapability>[] = [];
    for (const extension of extensions) {
        server.registerCapabilities({ extensions: { [extension.id]: {} } });
        if ('setup' in extension) {
            extension.setup(contextFor(mcp, extension.id, requirements));
        } else {
            extension.attach(mcp);
        }
    }

    const check = extensionRequirementsCheck('server', ids, requirements);
    return () => check(server.getCapabilities());
}

/** The context one extension's `setup` receives; everything it registers is attributed to `id`. */
function contextFor(mcp: McpServer, id: string, requirements: ExtensionRequirement<ServerCoreCapability>[]): ServerExtensionContext {
    const server = mcp.server;
    return {
        mcp,
        capability(settings) {
            server.registerCapabilities({ extensions: { [id]: settings } });
        },
        require(dependency) {
            requirements.push({ extension: id, dependency });
        },
        use(method, middleware) {
            server.use(method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(server, id, name, schemas, handler);
        }
    };
}
