# pluggy-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [Pluggy API](https://docs.pluggy.ai) data-products surface, deployed on Cloudflare Workers.

Built with [Cloudflare Agents](https://developers.cloudflare.com/agents/) (`McpAgent`) using the Streamable HTTP transport.

## Tools

Exposes 24 tools across Pluggy's data products:

| Domain | Tools |
| --- | --- |
| Items | `retrieve_item`, `create_item`, `update_item`, `delete_item`, `send_item_mfa` |
| Accounts | `list_accounts`, `retrieve_account`, `get_real_time_balance` |
| Transactions | `list_transactions`, `retrieve_transaction`, `update_transaction_category` |
| Investments | `list_investments`, `retrieve_investment`, `list_investment_transactions` |
| Identities | `find_identity_by_item`, `retrieve_identity` |
| Categories | `list_categories`, `retrieve_category` |
| Loans | `list_loans`, `retrieve_loan` |
| Credit card bills | `list_bills`, `retrieve_bill` |
| Connectors | `list_connectors`, `retrieve_connector` |

Payments, webhooks, and Smart Transfers are out of scope.

## Authentication

The MCP client authenticates with a Bearer token on every request:

```
Authorization: Bearer <base64(clientId:clientSecret)>
```

Generate the token:

```bash
printf '%s:%s' "$PLUGGY_CLIENT_ID" "$PLUGGY_CLIENT_SECRET" | base64
```

The Worker decodes the token, mints a short-lived Pluggy API key via `POST /auth` (2h TTL, refreshed 5min before expiry), and sends it as `X-API-KEY` on all Pluggy API calls. Pluggy credentials never reach the MCP client.

## Develop

```bash
npm install
npm run dev   # wrangler dev on http://127.0.0.1:8787
```

## Deploy

```bash
npx wrangler deploy
```

## Connect

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pluggy": {
      "url": "https://<your-worker>.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <base64(clientId:clientSecret)>" }
    }
  }
}
```

### Claude Desktop / Windsurf

Same shape, different config file (`claude_desktop_config.json` / `~/.codeium/windsurf/mcp_config.json`).

## Notes

- Pass `?itemId=<uuid>` on the `/mcp` URL to set a session-default item for item-scoped tools (`list_accounts`, `list_investments`, `find_identity_by_item`, `list_loans`); each also accepts an explicit `itemId` arg. Get the id from the `create_item` response or the Pluggy dashboard.
- `list_transactions` uses the cursor-based `GET /v2/transactions` endpoint. Pass the `after` cursor from a previous response's `next` value to paginate.
- The Durable Object persists the session and the minted API key for its lifetime; credentials are passed per-request via the Worker fetch handler into `ctx.props`.
