# workers-mount

Mount `createMcpHandler` bare on a fetch-native runtime (Cloudflare Workers, Deno, Bun) for a server that is **deployed on a public hostname**, not only run on localhost.

`createMcpHandler` is path-agnostic and does no Host or Origin validation by design. A Worker that does `export default { fetch: handler.fetch }` therefore answers MCP on `POST /`, `POST /mcp/` and any other path, with no DNS-rebinding guard. The `localhostAllowed*` helpers cover local development, but a deployed Worker also has to allow its own hostname.

`server.ts` is one `fetch(request)` handler that:

1. serves MCP on exactly `/mcp` and returns `404` for every other path;
2. checks Host and Origin with the SDK's `hostHeaderValidationResponse` and `originValidationResponse`, with allowlists that hold localhost **plus the public hostname**, and additionally requires `https:` for non-loopback browser origins (the SDK helpers compare hostnames only);
3. lowers `maxRequestBodySize` to 256 KiB.

`client.ts` checks each guard (`404`, `403`, `413`) and then makes a normal tool call with the SDK client.

On Workers, drop the `node:http` bridge and export the handler directly. Set `PUBLIC_HOSTNAME` to the Worker's own hostname (for example from a `[vars]` entry, read once from `env`) and build the two allowlists from it:

```ts
export default { fetch: fetchHandler };
```

HTTP-only by definition. This pattern comes from a production Worker (an MCP server for board meeting minutes) where the first deploy answered tool calls on `/` and `/mcp/`, and an Origin check that trusted the request's own URL could be bypassed with DNS rebinding.
