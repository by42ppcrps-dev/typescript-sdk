/**
 * Mounting `createMcpHandler` bare on a fetch-native runtime (Cloudflare
 * Workers, Deno, Bun) for a server that is reachable on a public hostname,
 * not only on localhost.
 *
 * `createMcpHandler` is deliberately path-agnostic and validation-free, so a
 * Worker that does `export default { fetch: handler.fetch }` answers MCP on
 * every path (`POST /`, `POST /mcp/`, `POST /anything`) with no Host or Origin
 * check. This fetch entry adds the three things a deployed Worker needs:
 *
 * 1. One exact MCP path. Everything else is `404` before the handler runs.
 * 2. Host and Origin allowlists that include the public hostname as well as
 *    localhost (for `wrangler dev`), using the SDK's own
 *    `hostHeaderValidationResponse` / `originValidationResponse`. Non-loopback
 *    browser origins must also be `https:`, because the SDK helpers compare
 *    hostnames only.
 * 3. A body cap sized for the server (`maxRequestBodySize`), here 256 KiB
 *    instead of the 4 MiB default.
 *
 * On Workers the whole file reduces to `export default { fetch: fetchHandler }`
 * with `PUBLIC_HOSTNAME` read from `env`; on Node, `toNodeHandler` bridges it
 * onto `node:http`. HTTP-only by definition.
 */
import { createServer } from 'node:http';

import { parseExampleArgs } from '@mcp-examples/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    McpServer,
    originValidationResponse
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 256 * 1024;
// On Workers: `env.PUBLIC_HOSTNAME`, e.g. `my-server.my-account.workers.dev`.
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME ?? 'example-mcp.workers.dev';

const allowedHosts = [...localhostAllowedHostnames(), PUBLIC_HOSTNAME];
const allowedOrigins = [...localhostAllowedOrigins(), PUBLIC_HOSTNAME];
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

function notFound(): Response {
    return Response.json({ error: 'not found' }, { status: 404 });
}

function insecureOriginResponse(request: Request): Response | undefined {
    const origin = request.headers.get('origin');
    if (!origin) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return undefined; // originValidationResponse already rejects unparseable origins
    }
    if (loopback.has(parsed.hostname) || parsed.protocol === 'https:') return undefined;
    return Response.json(
        { jsonrpc: '2.0', error: { code: -32_000, message: `Origin ${origin} must use https` }, id: null },
        { status: 403 }
    );
}

const handler = createMcpHandler(
    () => {
        const server = new McpServer({ name: 'workers-mount-example', version: '1.0.0' });
        server.registerTool(
            'echo',
            { description: 'Echoes the given text.', inputSchema: z.object({ text: z.string() }) },
            async ({ text }) => ({ content: [{ type: 'text', text }] })
        );
        return server;
    },
    { maxRequestBodySize: MAX_BODY_BYTES }
);

async function fetchHandler(request: Request): Promise<Response> {
    // 1. Exact path: no trailing slash, no root, no other paths.
    if (new URL(request.url).pathname !== MCP_PATH) return notFound();
    // 2. Host and Origin, for the deployed hostname and for local dev.
    const rejected =
        hostHeaderValidationResponse(request, allowedHosts) ??
        originValidationResponse(request, allowedOrigins) ??
        insecureOriginResponse(request);
    if (rejected) return rejected;
    // 3. Body cap is enforced by the handler itself (maxRequestBodySize above).
    return handler.fetch(request);
}

const { port } = parseExampleArgs();
createServer(toNodeHandler({ fetch: fetchHandler })).listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}${MCP_PATH} (public hostname ${PUBLIC_HOSTNAME})`);
});
