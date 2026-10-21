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
2. If that misses, `search_leads` or `search_properties` (address, APN, owner, phone, or ref id). `searchBy` `name` on leads, or `owner` on parcels, groups one seller's parcels. `list_campaigns` searches campaigns the same way.
3. Read `organizationName` / `organizationId` on the hit so you know which company it is.
4. Pass that `organizationId` to `create_lead`, `add_property_to_lead`, `update_lead`, `update_property_enrichment`, `upsert_due_diligence`, `add_dd_comp`, `update_dd_item`, `add_contact_note`, `create_campaign`, or `edit_campaign`.

Omit `organizationId` on those searches to cover every membership. A cross-org key must send `organizationId` on every write. If it is missing, the tool returns `ORGANIZATION_REQUIRED` and the company list instead of picking one.

## Tools

| Tool | What changed |
| --- | --- |
| `list_organizations` | New. Companies the key can use (`organizationId`, `name`, `role`). |
| `lookup_offer_code` | New. Exact property and campaign-ref matches, then partial property matches, across companies. |
| `search_leads` | Searches every company by default. Optional `organizationId`. `searchBy` adds `refId`. `searchBy` `name` groups a seller's parcels. Hits include company name and id. |
| `search_properties` | Same, including parcels with no lead. `searchBy` adds `refId`. `searchBy` `owner` groups a seller's parcels. |
| `list_campaigns` | Searches every company. Optional `query` and `organizationId`. |
| `get_lead`, `get_campaign`, `list_lead_images` | Find the record in either company unless `organizationId` is set. `get_lead` returns every linked parcel the API provides, plus pricing totals. |
| `list_leads`, `list_properties`, `list_tasks`, `get_kpis`, analytics tools | Still one company (home company unless `organizationId` is set). |
| `get_due_diligence` | Reads the structured due diligence section for a lead or for a parcel with no lead. |
| `create_lead`, `update_lead`, `delete_lead`, `add_contact_note` | Take `organizationId` and send it. |
| `add_property_to_lead` | Links another parcel to an existing lead by `refId`, or by `apn` with `county` and `state`. Optional per-parcel `offerPrice`, `purchasePrice`, and `sellingPrice`. |
| `update_property_enrichment` | Sets `enrichmentMarkdown` on a property and stamps `enrichedAt`. Takes `propertyId` and `organizationId`. |
| `upsert_due_diligence` | Partial update of one parcel's due diligence. `propertyId` or `parcelApn` selects the parcel on a lead and is optional when that lead has one parcel. |
| `add_dd_comp` | Appends one sold or active comparable with `comps.add` on the same PATCH. |
| `update_dd_item` | Updates one risk or open item with `items.update` on the same PATCH. |
| `upload_lead_image`, `delete_lead_image` | Take `organizationId` and send it. Image uploads send `image/png`, `image/jpeg`, `image/gif`, or `image/webp` from magic bytes, then the file extension. |
| `create_campaign` | Imports a local CSV or XLSX property file. Requires `name`, a unique `refId` prefix, and `filePath`; sends a multipart upload to the given company. |
| `edit_campaign`, `delete_campaign` | Take `organizationId` and send it. |

Writes send `X-Organization-Id`. JSON writes also include `organizationId` in the body. Deletes and GETs also send it as a query parameter when it is set.

## Several parcels on one lead

A lead can hold more than one parcel. `add_property_to_lead` posts to `POST /leads/{leadId}/properties` in the lead's company. `get_lead` reads `properties` on the lead when the API sends that array. If the lead has only the older singular `property`, `get_lead` also calls `GET /leads/{leadId}/properties`. Ids in both paths are `encodeURIComponent`'d. A cross-org key must pass `organizationId`; the write uses the same `X-API-Key`, `X-Organization-Id`, and JSON `organizationId` as `create_lead`. A single-org key may omit it.

```json
{
  "leadId": "lead-id-from-get-lead",
  "refId": "HOL-301-95",
  "offerPrice": 2000,
  "organizationId": "company-id-from-the-lead"
}
```

Pass `apn`, `county`, and `state` instead of `refId` when the parcel is not already in the company. County and state are required in that case. The tool returns `PROPERTY_IDENTIFIER_REQUIRED` when both `refId` and `apn` are missing, and `COUNTY_AND_STATE_REQUIRED` when an APN has no county or state. It does not call the API for those. `ORGANIZATION_REQUIRED` is the same company-list error as the other writes.

`search_leads` with `searchBy` `name`, and `search_properties` with `searchBy` `owner`, set `groupedBy` to `owner`. Parcels for the same owner name in the same company are one result, with `properties`, `leadIds`, and `pricing`. A lead search also keeps the original hits on `leads`. Address, APN, phone, and ref-id searches stay a flat list. Owner matching ignores case and repeated spaces. The same name in two companies stays two groups.

`pricing` on a lead or an owner group is computed here from numeric `offerPrice`, `purchasePrice`, and `sellingPrice` on the parcels actually returned. `propertyCount` is the number of those parcels. A price field that is missing on some parcels is still summed from the parcels that have it, and `offerPriceCount` (or the matching count field) says how many parcels contributed. This server does not invent prices or parcels.

`s10mcow/land-tools-api` is not in this repo, and this environment could not read that private repository or a live API host. The client calls the routes below and does not fill in parcels the API did not return. When `GET /leads/{leadId}/properties` is missing (`404` whose body says the route cannot be found), `get_lead` returns only the parcel embedded on the lead and sets `propertiesNote`. Deploy the API-key handlers before treating `properties` as the seller's full set:

- Auth: existing API-key middleware. `X-API-Key`, and `X-Organization-Id` when the key is cross-org. Another company's lead id is a 404.
- `GET /leads/{leadId}`: keep the current lead payload and add `properties`, an array of every parcel linked to that lead. Each parcel includes `id`, `refId`, `apn`, `county`, `state`, `offerPrice`, `purchasePrice`, and `sellingPrice` when those values exist. The singular `property` may stay as the original parcel.
- `GET /leads/{leadId}/properties`: the same parcel array, or `{ "properties": [ ... ] }`. Empty means the lead has no parcels.
- `POST /leads/{leadId}/properties`: body is `refId` and/or `apn`, plus `county` and `state` when the caller is finding or creating by APN, plus any of `offerPrice`, `purchasePrice`, `sellingPrice`, and `organizationId` for a cross-org key. `refId` links a parcel already in that company. `apn` + `county` + `state` finds a parcel in that company or creates it, then links it to the lead. Linking a parcel that is already on the lead returns the existing link. Do not detach the lead's other parcels. Return the lead, or the linked parcel, including the prices that were stored.
- Schema: a lead has many parcels. Prices live on the parcel. The lead total is not a stored column this server writes.
- `GET /cross-org/leads/search` and `GET /cross-org/properties/search` (and the home-company fallbacks): an owner-name query should return every parcel for that seller, including later parcels linked to an existing lead. This server groups those hits. It cannot group a parcel the search response omitted.
- `land-bridge-web` needs to render `properties` and the per-parcel prices. That change is not in this repo.

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

## Due diligence

Due diligence is a structured record per parcel, not a contact note. The wire contract matches [land-tools-api #40](https://github.com/s10mcow/land-tools-api/pull/40). There is one read and one write route per lead or property. Comps and items are patches on that same route, not separate paths.

```json
{
  "leadId": "lead-id-from-search",
  "propertyId": "property-id-from-the-lead",
  "parcelApn": "12-34-567",
  "expectedRevision": 3,
  "status": "IN_PROGRESS",
  "title": { "ownerOfRecord": "Ada Lovelace", "seller": "OWNER", "deedPrice": "15000.50" },
  "valuation": { "offerTarget": "18000.00" },
  "organizationId": "company-id-from-the-search-hit"
}
```

`get_due_diligence` checks every company unless `organizationId` is set, the same way `get_lead` does. The write tools follow `update_property_enrichment`: a cross-org key must pass `organizationId` or the tool returns `ORGANIZATION_REQUIRED` and does not call the API. A single-org key may omit it. Ids in the path are `encodeURIComponent`'d. Text fields are capped (2,000 characters for short fields, 20,000 for legal description, covenants, rationale, and item text), and the JSON body must stay within 100,000 characters.

| Tool | Request |
| --- | --- |
| `get_due_diligence` | `GET /leads/{leadId}/due-diligence` or `GET /properties/{propertyId}/due-diligence`. On the lead route, `parcelApn` and `propertyId` are optional query selectors. |
| `upsert_due_diligence` | `PATCH` on that same path. Body is the selectors plus only the sections you set. |
| `add_dd_comp` | `PATCH` on that same path with `comps: { add: [{ address, acres, price, date, status, url }] }`. |
| `update_dd_item` | `PATCH` on that same path with `items: { update: [{ itemId, kind, status, text, sourceUrl }] }`. |

On a lead, `propertyId` or `parcelApn` selects the parcel. Leave both off when the lead has one parcel. A parcel with no lead uses the property route, and those selectors stay out of the body. `expectedRevision` is the revision from the last read. When it is stale the API returns 409 `DD_CONFLICT`; the tool returns that code, the API body, and tells you to read again and retry. It does not hide the conflict as a generic request failure.

`PATCH` is partial. Omitted sections stay as they are. Inside a section, omitted keys stay as they are. Amounts (`deedPrice`, land and assessed value, `taxAmount`, dues, market and offer values, and comp `price`) are sent as 2-decimal strings such as `"15000.50"`. Dates (`deedDate`, comp `date`) are `YYYY-MM-DD`.

Nested groups are `parcel`, `title`, `values`, `access`, `buildability`, `restrictions`, and `valuation`. Enums: status `NOT_STARTED` / `IN_PROGRESS` / `COMPLETE` / `PASS`; `title.seller` `OWNER` / `SPOUSE` / `HEIR` / `ENTITY` / `OTHER`; `access.road` `PAVED` / `GRAVEL` / `DIRT` / `NONE`; `access.maintenance` `COUNTY` / `PRIVATE`; `values.trustee` `PAID` / `DELINQUENT`; comp status `SOLD` / `ACTIVE`; item `kind` `RISK` / `OPEN_ITEM`; item status `OPEN` / `VERIFIED` / `NA`.

`list_leads` and `search_leads` do not take a due diligence status or value range. That contract does not include `ddStatus`, `valueMin`, or `valueMax`, so those arguments are not sent.

The lead UI, and moving the existing free-text due diligence notes on leads `363ce55b-e1a1-43ec-9a97-e38962419bb6` and `be07aab4-29a8-46e5-9094-d700a6234c93` into this structure, live in the API and web app. This server only reads and writes the section.

## Development

```bash
npm test
npm run build
```
