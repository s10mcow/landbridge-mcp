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

The organization-list response includes the key's `crossOrg` flag. HTTP 200 also applies to single-org keys; it does not imply cross-org credentials. A cross-org key needs `organizationId` even if it currently has only one membership. When an older API omits this metadata for a single membership, the server enforces the write requirement.

Market-research routes are unchanged on the API and still use the key's home company. This server does not call them.

## How a call should go

1. `lookup_offer_code` with the code on the mailer (`DNA-12A-506` and `dna12a506` are the same code).
2. If that misses, `search_leads` or `search_properties` (address, APN, owner, phone, or ref id). `list_campaigns` searches campaigns the same way.
3. Read `organizationName` / `organizationId` on the hit so you know which company it is.
4. Pass that `organizationId` to `create_lead`, `update_lead`, `update_property_enrichment`, `add_contact_note`, `create_campaign`, or `edit_campaign`.

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
| `update_property_enrichment` | Sets `enrichmentMarkdown` on a property and stamps `enrichedAt`. Takes `propertyId` and `organizationId`. |
| `upload_lead_image`, `delete_lead_image` | Take `organizationId` and send it. |
| `create_campaign` | Imports a local CSV or XLSX property file. Requires `name`, a unique `refId` prefix, and `filePath`; sends a multipart upload to the given company. |
| `edit_campaign`, `delete_campaign` | Take `organizationId` and send it. |

Writes send `X-Organization-Id`. JSON writes also include `organizationId` in the body. Deletes and GETs also send it as a query parameter when it is set.

## Property enrichment

`update_property_enrichment` saves public-records markdown onto a parcel that has no lead yet, or onto the property attached to a lead. `search_leads` already returns this text on `property.enrichmentMarkdown`, with `property.enrichedAt`.

```json
{
  "propertyId": "property-id-from-search",
  "enrichmentMarkdown": "# Public records\n\nOwner, deed, and tax notes.",
  "organizationId": "company-id-from-the-search-hit"
}
```

The tool `PATCH`es `/properties/{propertyId}/enrichment` with `enrichmentMarkdown`, an ISO-8601 `enrichedAt` stamped at call time, and the company selector. It does not change any other property field. A cross-org key that omits `organizationId` gets `ORGANIZATION_REQUIRED` and does not write. A single-org key may omit it and the write stays on that key's home company.

The parcel has to belong to that company. This server cannot see a property-by-id route, so the API must enforce that: if the id is missing or sits in another company, respond 404 and do not update the row.

`PATCH /properties/{propertyId}/enrichment` is already mounted on the Landbridge API that backs [landbridge.app](https://www.landbridge.app) (an unknown path returns 500; this path returns 401 until a bearer token is sent). That public entry checks `Authorization`, not `X-API-Key`. The MCP server calls the same path with `X-API-Key` against `MCP_API_URL`. The API-key router in `s10mcow/land-tools-api` needs this handler, with the same company check as `PATCH /leads/{leadId}`:

- Auth: existing API-key middleware.
- Body: `enrichmentMarkdown` (string), `enrichedAt` (ISO-8601), and `organizationId` when the key is cross-org.
- Load the property by id inside the caller's organization. Another company's id is a 404.
- Persist `enrichmentMarkdown`. Persist `enrichedAt` from the body when it is a valid timestamp; otherwise set the server clock.
- Return the property, including both fields.
- Do not write any other column from this route.

`s10mcow/land-bridge-web` only renders `enrichmentMarkdown` and `enrichedAt`. It does not need a change for this write. Both repositories are private to this agent's GitHub token, so the API change is specified here instead of opened as a pull request. Deploy `land-tools-api` if the API-key surface does not already serve this route, then restart MCP clients on this package so they pick up the tool.

For `create_campaign`, pass an existing local CSV or XLSX property import file:

```json
{
  "name": "Spring mailer",
  "refId": "DNA",
  "filePath": "/absolute/path/to/properties.csv",
  "organizationId": "company-id-from-list_organizations"
}
```

The file is uploaded with its CSV/XLSX content type along with `name`, `refId`, and the organization selector.

The `landbridge://organization` resource is still the key's home company.

## Development

```bash
npm test
npm run build
```
