/**
 * Asserts the guards in `server.ts`: MCP only on the exact path, Host and
 * Origin allowlists (including the public hostname, https only), the 256 KiB
 * body cap, and then a normal tool call through the SDK client.
 */
import { request as httpRequest } from 'node:http';

import { check, parseExampleArgs } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { url, era } = parseExampleArgs();
const endpoint = new URL(url);
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function post(path: string, headers: Record<string, string> = {}, body = ping): Promise<number> {
    const res = await fetch(new URL(path, endpoint), { method: 'POST', headers: { ...jsonHeaders, ...headers }, body });
    await res.arrayBuffer();
    return res.status;
}

// `fetch` cannot override Host, so send that one probe over node:http.
function postWithHost(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                hostname: endpoint.hostname,
                port: endpoint.port,
                path: endpoint.pathname,
                method: 'POST',
                headers: { ...jsonHeaders, host }
            },
            res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            }
        );
        req.on('error', reject);
        req.end(ping);
    });
}

// 1. Only the exact MCP path is served.
check.equal(await post('/'), 404);
check.equal(await post(`${endpoint.pathname}/`), 404);
check.equal(await post('/anything'), 404);

// 2. Host and Origin.
check.equal(await postWithHost('evil.example'), 403);
check.equal(await post(endpoint.pathname, { origin: 'https://evil.example' }), 403);
check.equal(await post(endpoint.pathname, { origin: 'http://example-mcp.workers.dev' }), 403);
check.equal(await post(endpoint.pathname, { origin: 'null' }), 403);
const publicOrigin = await post(endpoint.pathname, { origin: 'https://example-mcp.workers.dev' });
check.ok(publicOrigin !== 403 && publicOrigin !== 404, `public https origin should reach the handler, got ${publicOrigin}`);

// 3. Body cap: 300 KiB is over the 256 KiB bound and is refused before parsing.
check.equal(
    await post(endpoint.pathname, {}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } })),
    413
);

// A normal client (no Origin header, like any non-browser MCP client) works.
const client = new Client(
    { name: 'workers-mount-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);
await client.connect(new StreamableHTTPClientTransport(endpoint));
const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'hello');
await client.close();
