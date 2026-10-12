#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { z } from "zod";
import { createApiClientFromEnv } from "./api-client.js";
import { createMultiOrg, type AcrossOrgsResult, type MutateResult } from "./multi-org.js";

const server = new McpServer({
  name: "landbridge",
  version: "0.2.0",
});

const api = createApiClientFromEnv();
const lb = createMultiOrg(api);

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : json(data) }] };
}

function fail(data: unknown): ToolResult {
  return { ...ok(data), isError: true };
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail({ error: "REQUEST_FAILED", message });
  }
}

function fromMutate(result: MutateResult, successText?: string): ToolResult {
  if (!result.ok) return fail(result.error);
  return ok(successText ?? result.data);
}

function oneOrMany(noun: string, found: AcrossOrgsResult): ToolResult {
  if (found.hits.length === 0) {
    const message = found.crossOrg
      ? `${noun} not found in any company this key can access.`
      : `${noun} not found`;
    return ok(message);
  }
  if (found.hits.length === 1) return ok(found.hits[0].data);
  return ok({
    note: `This id matched in more than one company.`,
    results: found.hits.map((hit) => hit.data),
  });
}

const writeOrg = z
  .string()
  .optional()
  .describe(
    "Company id (organizationId) this change belongs to. Required for cross-org API keys, even with only one current membership. Copy it from the search hit or from list_organizations. If you omit it, the tool lists the companies instead of guessing.",
  );

const filterOrg = z
  .string()
  .optional()
  .describe("Limit to one company (organizationId). Omit to search every company this key belongs to.");

const readOrg = z
  .string()
  .optional()
  .describe(
    "Company id to read. Omit to use the API key's home company. This does not fan out across companies; use search_leads, search_properties, list_campaigns, or lookup_offer_code for that.",
  );

const lookupOrg = z
  .string()
  .optional()
  .describe("Company id to look in. Omit to check every company this key belongs to.");

// ==================== READ TOOLS ====================

server.tool(
  "list_organizations",
  "List every Landbridge company this API key can use, with organizationId, name, and role. Call this before a write if you do not already have the company id from a search hit.",
  {},
  async () => run(async () => ok(await lb.listOrganizations())),
);

server.tool(
  "lookup_offer_code",
  "Look up a mailer offer code (for example DNA-12A-506) across every company this key belongs to. Dashes and case do not matter. Exact property and campaign-ref matches come first, then partial property matches. Each hit has matchType (property, campaign, or partial_property), plus campaign, property, lead, organizationName, and organizationId. Use the organizationId on later writes. If cross-company lookup is unavailable, falls back to a home-company search and says so.",
  {
    code: z.string().describe("Offer code printed on the mailer, such as DNA-12A-506"),
    organizationId: filterOrg,
  },
  async ({ code, organizationId }) =>
    run(async () => {
      const result = await lb.lookupOfferCode(code, organizationId);
      if (result.error === "OFFER_CODE_REQUIRED") return fail(result);
      return ok(result);
    }),
);

server.tool(
  "list_leads",
  "List leads in one company, with property and campaign info. Defaults to the API key's home company. To find a person who might be in either company, use search_leads or lookup_offer_code.",
  {
    stage: z
      .string()
      .optional()
      .describe("Filter by stage: NEW, NEGOTIATING, UNDER_CONTRACT, CLOSED, etc."),
    limit: z.number().optional().describe("Max results (default 50)"),
    organizationId: readOrg,
  },
  async ({ stage, limit, organizationId }) =>
    run(async () => {
      const params = new URLSearchParams();
      if (stage) params.set("stage", stage);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      return ok(await lb.read(`/leads${qs ? `?${qs}` : ""}`, organizationId));
    }),
);

server.tool(
  "get_lead",
  "Get a lead by id. Checks every company this key belongs to unless organizationId is set. The result is labeled with organizationName and organizationId.",
  {
    leadId: z.string().describe("The lead ID"),
    organizationId: lookupOrg,
  },
  async ({ leadId, organizationId }) =>
    run(async () => oneOrMany("Lead", await lb.readAcrossOrganizations(`/leads/${leadId}`, organizationId))),
);

server.tool(
  "search_leads",
  "Search leads across every company by name, address, APN, phone, or property ref id. Omit organizationId to cover all companies. Each hit includes organizationName, organizationId, and organizationLabel. Pass that organizationId to create_lead, update_lead, or add_contact_note.",
  {
    query: z.string().describe("Search term"),
    searchBy: z
      .enum(["name", "address", "apn", "phone", "refId"])
      .optional()
      .describe("Field to search. Omit to search all of these fields."),
    organizationId: filterOrg,
    limit: z.number().optional().describe("Max results"),
  },
  async ({ query, searchBy, organizationId, limit }) =>
    run(async () => ok(await lb.searchLeads({ query, searchBy, organizationId, limit }))),
);

server.tool(
  "list_campaigns",
  "List or search campaigns across every company. Each campaign is labeled with organizationName and organizationId. Pass a query to filter by name or code, or organizationId to stay in one company. Use get_campaign for one campaign's properties, leads, and marketing.",
  {
    query: z.string().optional().describe("Optional name or code filter"),
    organizationId: filterOrg,
    limit: z.number().optional().describe("Max results"),
  },
  async ({ query, organizationId, limit }) =>
    run(async () => ok(await lb.listCampaigns({ query, organizationId, limit }))),
);

server.tool(
  "get_campaign",
  "Get a campaign by id, including properties, leads, and marketing. Checks every company unless organizationId is set.",
  {
    campaignId: z.string().describe("The campaign ID"),
    organizationId: lookupOrg,
  },
  async ({ campaignId, organizationId }) =>
    run(async () =>
      oneOrMany("Campaign", await lb.readAcrossOrganizations(`/campaigns/${campaignId}`, organizationId)),
    ),
);

server.tool(
  "list_properties",
  "List properties in one company, optionally filtered by campaign. Defaults to the API key's home company. To search parcels in every company, including those with no lead, use search_properties.",
  {
    campaignId: z.string().optional().describe("Filter by campaign ID"),
    hasLead: z.boolean().optional().describe("Filter: true=only with leads, false=only without"),
    limit: z.number().optional().describe("Max results (default 50)"),
    organizationId: readOrg,
  },
  async ({ campaignId, hasLead, limit, organizationId }) =>
    run(async () => {
      const params = new URLSearchParams();
      if (campaignId) params.set("campaignId", campaignId);
      if (hasLead !== undefined) params.set("hasLead", String(hasLead));
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      return ok(await lb.read(`/properties${qs ? `?${qs}` : ""}`, organizationId));
    }),
);

server.tool(
  "search_properties",
  "Search parcels across every company by address, APN, owner name, or ref id, including parcels with no lead. Omit organizationId to cover all companies. Each hit includes organizationName and organizationId.",
  {
    query: z.string().describe("Search term (street, APN, owner name, or ref id)"),
    searchBy: z
      .enum(["address", "apn", "owner", "refId"])
      .optional()
      .describe("Field to search. Omit to search address, APN, owner, and ref id."),
    organizationId: filterOrg,
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, searchBy, organizationId, limit }) =>
    run(async () => ok(await lb.searchProperties({ query, searchBy, organizationId, limit }))),
);

server.tool(
  "get_kpis",
  "Get KPI dashboard for one company: current month, last month, YTD, and lifetime metrics. Defaults to the API key's home company.",
  { organizationId: readOrg },
  async ({ organizationId }) => run(async () => ok(await lb.read("/kpi", organizationId))),
);

server.tool(
  "list_tasks",
  "List tasks for one company. Defaults to the API key's home company.",
  {
    isCompleted: z.boolean().optional().describe("Filter by completion status"),
    organizationId: readOrg,
  },
  async ({ isCompleted, organizationId }) =>
    run(async () => {
      const params = new URLSearchParams();
      if (isCompleted !== undefined) params.set("isCompleted", String(isCompleted));
      const qs = params.toString();
      return ok(await lb.read(`/tasks${qs ? `?${qs}` : ""}`, organizationId));
    }),
);

// ==================== ANALYTICS TOOLS ====================

server.tool(
  "pipeline_velocity",
  "Analyze how fast leads move through stages in one company — average days per stage, bottlenecks, and fall-off rates. Defaults to the home company.",
  { organizationId: readOrg },
  async ({ organizationId }) =>
    run(async () => ok(await lb.read("/analytics/pipeline-velocity", organizationId))),
);

server.tool(
  "campaign_roi",
  "Calculate ROI for each campaign in one company: marketing spend vs revenue from closed deals. Defaults to the home company.",
  { organizationId: readOrg },
  async ({ organizationId }) =>
    run(async () => ok(await lb.read("/analytics/campaign-roi", organizationId))),
);

server.tool(
  "deal_economics",
  "Analyze deal profitability for one company: avg purchase price, selling price, profit, margins, and assignment vs direct deals. Defaults to the home company.",
  { organizationId: readOrg },
  async ({ organizationId }) =>
    run(async () => ok(await lb.read("/analytics/deal-economics", organizationId))),
);

server.tool(
  "weighted_pipeline",
  "Calculate weighted pipeline value for one company based on stage probability. Defaults to the home company.",
  { organizationId: readOrg },
  async ({ organizationId }) =>
    run(async () => ok(await lb.read("/analytics/weighted-pipeline", organizationId))),
);

server.tool(
  "stale_leads",
  "Find leads in one company that have not been contacted recently. Defaults to the home company.",
  {
    daysSinceContact: z
      .number()
      .optional()
      .describe("Days since last contact to consider stale (default 14)"),
    stage: z.string().optional().describe("Filter by stage"),
    organizationId: readOrg,
  },
  async ({ daysSinceContact, stage, organizationId }) =>
    run(async () => {
      const params = new URLSearchParams();
      if (daysSinceContact) params.set("daysSinceContact", String(daysSinceContact));
      if (stage) params.set("stage", stage);
      const qs = params.toString();
      return ok(await lb.read(`/analytics/stale-leads${qs ? `?${qs}` : ""}`, organizationId));
    }),
);

// ==================== WRITE TOOLS ====================

server.tool(
  "update_lead",
  "Update a lead's stage, contact info, or pricing in a specific company. The lead must already belong to that company. Pass organizationId from the search hit.",
  {
    leadId: z.string().describe("The lead ID"),
    organizationId: writeOrg,
    stage: z
      .string()
      .optional()
      .describe("NEW, NEGOTIATING, UNDER_CONTRACT, CLOSED, COLD, FOLLOW_UP, etc."),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    purchasePrice: z.number().optional(),
    sellingPrice: z.number().optional(),
    notes: z.string().optional(),
  },
  async ({ leadId, organizationId, ...updates }) =>
    run(async () => fromMutate(await lb.mutate({
      method: "PATCH",
      path: `/leads/${leadId}`,
      organizationId,
      body: updates,
    }))),
);

server.tool(
  "create_lead",
  "Create a lead from a property ref id in a specific company. The parcel must already be in that company. Pass organizationId from lookup_offer_code or search_properties.",
  {
    refId: z
      .string()
      .describe("Property reference id. Dashes are optional (PBCS10152063 or PB-CS-1015-2063)."),
    organizationId: writeOrg,
  },
  async ({ refId, organizationId }) =>
    run(async () => fromMutate(await lb.mutate({
      method: "POST",
      path: "/leads",
      organizationId,
      body: { refId },
    }))),
);

server.tool(
  "delete_lead",
  "Soft-delete a lead in a specific company. Pass organizationId from the lead.",
  {
    leadId: z.string().describe("The lead ID"),
    organizationId: writeOrg,
  },
  async ({ leadId, organizationId }) =>
    run(async () => fromMutate(
      await lb.mutate({ method: "DELETE", path: `/leads/${leadId}`, organizationId }),
      "Lead deleted",
    )),
);

server.tool(
  "add_contact_note",
  "Add a note to a lead in a specific company. Pass organizationId from the lead.",
  {
    leadId: z.string().describe("The lead ID"),
    content: z.string().describe("The note content"),
    organizationId: writeOrg,
  },
  async ({ leadId, content, organizationId }) =>
    run(async () => fromMutate(await lb.mutate({
      method: "POST",
      path: `/leads/${leadId}/contact-notes`,
      organizationId,
      body: { content },
    }))),
);

// ==================== IMAGE TOOLS ====================

server.tool(
  "list_lead_images",
  "List screenshots and images attached to a lead. Checks every company unless organizationId is set. Images are labeled with the company they belong to.",
  {
    leadId: z.string().describe("The lead ID"),
    organizationId: lookupOrg,
  },
  async ({ leadId, organizationId }) =>
    run(async () => {
      const found = await lb.readAcrossOrganizations(`/leads/${leadId}/images`, organizationId);
      if (found.hits.length === 0) return oneOrMany("Lead", found);
      const images = found.hits.flatMap((hit) => asList(hit.data));
      if (images.length === 0) return ok("No images found for this lead");
      return ok(images);
    }),
);

server.tool(
  "upload_lead_image",
  "Upload a screenshot or image to a lead from a local file path. Pass organizationId for the company that owns the lead.",
  {
    leadId: z.string().describe("The lead ID"),
    filePath: z.string().describe("Absolute path to the image file on disk"),
    description: z.string().optional().describe("Optional description of the screenshot"),
    organizationId: writeOrg,
  },
  async ({ leadId, filePath, description, organizationId }) =>
    run(async () => {
      if (!existsSync(filePath)) return ok("File not found: " + filePath);
      const fields: Record<string, string> = {};
      if (description) fields.description = description;
      return fromMutate(await lb.upload({
        path: `/leads/${leadId}/images`,
        filePath,
        fields,
        organizationId,
      }));
    }),
);

server.tool(
  "delete_lead_image",
  "Delete a screenshot or image from a lead. Pass organizationId for the company that owns the image.",
  {
    imageId: z.string().describe("The image ID"),
    organizationId: writeOrg,
  },
  async ({ imageId, organizationId }) =>
    run(async () => fromMutate(
      await lb.mutate({ method: "DELETE", path: `/leads/images/${imageId}`, organizationId }),
      "Image deleted",
    )),
);

// ==================== CAMPAIGN TOOLS ====================

server.tool(
  "create_campaign",
  "Create a campaign by importing a local CSV or XLSX property file. Provide its name and a unique reference-code prefix (refId). Pass organizationId from list_organizations or a search hit to choose the company.",
  {
    name: z.string().trim().min(1).describe("Campaign name"),
    refId: z.string().trim().min(1).describe("Unique campaign reference-code prefix, such as DNA"),
    filePath: z.string().regex(/\.(csv|xlsx)$/i).describe("Absolute path to the CSV or XLSX property file to import"),
    organizationId: writeOrg,
  },
  async ({ name, refId, filePath, organizationId }) =>
    run(async () => {
      if (!existsSync(filePath)) return fail({ error: "FILE_NOT_FOUND", message: "File not found: " + filePath });
      return fromMutate(await lb.upload({
        path: "/campaigns",
        filePath,
        fields: { name, refId },
        organizationId,
      }));
    }),
);

server.tool(
  "edit_campaign",
  "Rename a campaign in a specific company. Pass organizationId from the campaign.",
  {
    campaignId: z.string().describe("The campaign ID"),
    name: z.string().describe("New campaign name"),
    organizationId: writeOrg,
  },
  async ({ campaignId, name, organizationId }) =>
    run(async () => fromMutate(
      await lb.mutate({
        method: "PATCH",
        path: `/campaigns/${campaignId}`,
        organizationId,
        body: { name },
      }),
      "Campaign updated",
    )),
);

server.tool(
  "delete_campaign",
  "Soft-delete a campaign in a specific company. Pass organizationId from the campaign.",
  {
    campaignId: z.string().describe("The campaign ID"),
    organizationId: writeOrg,
  },
  async ({ campaignId, organizationId }) =>
    run(async () => fromMutate(
      await lb.mutate({ method: "DELETE", path: `/campaigns/${campaignId}`, organizationId }),
      "Campaign deleted",
    )),
);

function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["images", "results", "items", "data"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

// ==================== RESOURCES ====================

server.resource("organization", "landbridge://organization", async (uri) => {
  const org = await api.get("/organization");
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: json(org) }],
  };
});

// ==================== START ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LandBridge MCP server running on stdio");
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
