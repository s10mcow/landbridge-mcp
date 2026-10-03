# LandBridge MCP server

MCP tools for the LandBridge land-investment CRM. A landowner can call with a mailer offer code, address, APN, name, or phone. The assistant searches **every company the key belongs to**, shows which company each hit is in, then creates or updates the lead or campaign in that company.

## Setup for both companies

Auth is still a single `lbapi_sk_` key. Mint one key that can act in every company your user belongs to:

```json
{ "name": "MCP both companies", "scopes": ["*"], "crossOrg": true }
```

Put that key in the MCP server environment:

```json
{
  "mcpServers": {
    "landbridge": {
      "command": "node",
      "args": ["/absolute/path/to/landbridge-mcp/dist/index.js"],
      "env": {
        "MCP_API_KEY": "lbapi_sk_...",
        "MCP_API_URL": "https://api.landbridge.com"
      }
    }
  }
}
```

`MCP_API_URL` is optional and defaults to `https://api.landbridge.com`.

Build:

```bash
npm install
npm run build
```

Cross-company tools call `/cross-org/...` on the API. Deploy that API before using a `crossOrg` key. An older key (no `crossOrg`) keeps working, and so does a server that has no `/cross-org` routes: searches stay on the key's home company, and the tool result says so.

Market-research routes are unchanged on the API and still use the key's home company. This server does not call them.

## How a call should go

1. `lookup_offer_code` with the code on the mailer (`DNA-12A-506` and `dna12a506` are the same code).
2. If that misses, `search_leads` or `search_properties` (address, APN, owner, phone, or ref id). `list_campaigns` searches campaigns the same way.
3. Read `organizationName` / `organizationId` on the hit so you know which company it is.
4. Pass that `organizationId` to `create_lead`, `update_lead`, `add_contact_note`, `create_campaign`, or `edit_campaign`.

Omit `organizationId` on those searches to cover every membership. A cross-org key must send `organizationId` on every write. If it is missing, the tool returns `ORGANIZATION_REQUIRED` and the company list instead of picking one.

## Tools

| Tool | What changed |
| --- | --- |
| `list_organizations` | New. Companies the key can use (`organizationId`, `name`, `role`). |
| `lookup_offer_code` | New. Exact property and campaign-ref matches, then partial property matches, across companies. |
| `search_leads` | Searches every company by default. Optional `organizationId`. `searchBy` adds `refId`. Hits include company name and id. |
| `search_properties` | Same, including parcels with no lead. `searchBy` adds `refId`. |
| `list_campaigns` | Searches every company. Optional `query` and `organizationId`. |
| `get_lead`, `get_campaign`, `list_lead_images` | Find the record in either company unless `organizationId` is set. |
| `list_leads`, `list_properties`, `list_tasks`, `get_kpis`, analytics tools | Still one company (home company unless `organizationId` is set). |
| `create_lead`, `update_lead`, `delete_lead`, `add_contact_note` | Take `organizationId` and send it. |
| `upload_lead_image`, `delete_lead_image` | Take `organizationId` and send it. |
| `create_campaign` | New. Creates a campaign in the given company. |
| `edit_campaign`, `delete_campaign` | Take `organizationId` and send it. |

Writes send `X-Organization-Id`. JSON writes also include `organizationId` in the body. Deletes and GETs also send it as a query parameter when it is set.

The `landbridge://organization` resource is still the key's home company.

## Development

```bash
npm test
npm run build
```
