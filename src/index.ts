#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api } from "./api-client.js";
import { existsSync } from "node:fs";

const server = new McpServer({
  name: "landbridge",
  version: "0.1.0",
});

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ==================== READ TOOLS ====================

server.tool(
  "list_leads",
  "List leads for the organization with property and campaign info",
  {
    stage: z
      .string()
      .optional()
      .describe("Filter by stage: NEW, NEGOTIATING, UNDER_CONTRACT, CLOSED, etc."),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ stage, limit }) => {
    const params = new URLSearchParams();
    if (stage) params.set("stage", stage);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    const leads = await api.get(`/leads${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: json(leads) }] };
  },
);

server.tool(
  "get_lead",
  "Get detailed info about a specific lead",
  {
    leadId: z.string().describe("The lead ID"),
  },
  async ({ leadId }) => {
    const lead = await api.get(`/leads/${leadId}`);
    if (!lead) return { content: [{ type: "text" as const, text: "Lead not found" }] };
    return { content: [{ type: "text" as const, text: json(lead) }] };
  },
);

server.tool(
  "search_leads",
  "Search for leads/properties by name, address, APN, or phone",
  {
    query: z.string().describe("Search term"),
    searchBy: z
      .enum(["name", "address", "apn", "phone"])
      .optional()
      .describe("Field to search (default: searches all)"),
  },
  async ({ query, searchBy }) => {
    const params = new URLSearchParams({ query });
    if (searchBy) params.set("searchBy", searchBy);
    const leads = await api.get(`/leads/search?${params}`);
    if (!leads || (Array.isArray(leads) && leads.length === 0))
      return { content: [{ type: "text" as const, text: "No leads found" }] };
    return { content: [{ type: "text" as const, text: json(leads) }] };
  },
);

server.tool(
  "list_campaigns",
  "List campaigns with property counts, lead counts, and cost metrics",
  {
    limit: z.number().optional().describe("Max results"),
  },
  async ({ limit }) => {
    const campaigns = await api.get("/campaigns");
    const result = limit && Array.isArray(campaigns) ? campaigns.slice(0, limit) : campaigns;
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "get_campaign",
  "Get detailed campaign info with properties, leads, and marketing",
  {
    campaignId: z.string().describe("The campaign ID"),
  },
  async ({ campaignId }) => {
    const campaign = await api.get(`/campaigns/${campaignId}`);
    if (!campaign) return { content: [{ type: "text" as const, text: "Campaign not found" }] };
    return { content: [{ type: "text" as const, text: json(campaign) }] };
  },
);

server.tool(
  "list_properties",
  "List properties, optionally filtered by campaign",
  {
    campaignId: z.string().optional().describe("Filter by campaign ID"),
    hasLead: z.boolean().optional().describe("Filter: true=only with leads, false=only without"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ campaignId, hasLead, limit }) => {
    const params = new URLSearchParams();
    if (campaignId) params.set("campaignId", campaignId);
    if (hasLead !== undefined) params.set("hasLead", String(hasLead));
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    const properties = await api.get(`/properties${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: json(properties) }] };
  },
);

server.tool(
  "search_properties",
  "Search all properties by address, APN, or owner name — includes properties without leads",
  {
    query: z.string().describe("Search term (e.g. street name, APN, owner name)"),
    searchBy: z
      .enum(["address", "apn", "owner"])
      .optional()
      .describe("Field to search (default: searches address + APN + owner)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, searchBy, limit }) => {
    const params = new URLSearchParams({ query });
    if (searchBy) params.set("searchBy", searchBy);
    if (limit) params.set("limit", String(limit));
    const properties = await api.get(`/properties/search?${params}`);
    if (!properties || (Array.isArray(properties) && properties.length === 0))
      return { content: [{ type: "text" as const, text: "No properties found" }] };
    return { content: [{ type: "text" as const, text: json(properties) }] };
  },
);

server.tool(
  "get_kpis",
  "Get KPI dashboard: current month, last month, YTD, and lifetime metrics",
  {},
  async () => {
    const kpis = await api.get("/kpi");
    return { content: [{ type: "text" as const, text: json(kpis) }] };
  },
);

server.tool(
  "list_tasks",
  "List tasks",
  {
    isCompleted: z.boolean().optional().describe("Filter by completion status"),
  },
  async ({ isCompleted }) => {
    const params = new URLSearchParams();
    if (isCompleted !== undefined) params.set("isCompleted", String(isCompleted));
    const qs = params.toString();
    const tasks = await api.get(`/tasks${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: json(tasks) }] };
  },
);

// ==================== ANALYTICS TOOLS ====================

server.tool(
  "pipeline_velocity",
  "Analyze how fast leads move through stages — average days per stage, bottlenecks, and fall-off rates",
  {},
  async () => {
    const result = await api.get("/analytics/pipeline-velocity");
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "campaign_roi",
  "Calculate ROI for each campaign: marketing spend vs revenue from closed deals",
  {},
  async () => {
    const result = await api.get("/analytics/campaign-roi");
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "deal_economics",
  "Analyze deal profitability: avg purchase price, selling price, profit, margins, and assignment vs direct deals",
  {},
  async () => {
    const result = await api.get("/analytics/deal-economics");
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "weighted_pipeline",
  "Calculate weighted pipeline value based on stage probability",
  {},
  async () => {
    const result = await api.get("/analytics/weighted-pipeline");
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "stale_leads",
  "Find leads that haven't been contacted recently and may need follow-up",
  {
    daysSinceContact: z
      .number()
      .optional()
      .describe("Days since last contact to consider stale (default 14)"),
    stage: z.string().optional().describe("Filter by stage"),
  },
  async ({ daysSinceContact, stage }) => {
    const params = new URLSearchParams();
    if (daysSinceContact) params.set("daysSinceContact", String(daysSinceContact));
    if (stage) params.set("stage", stage);
    const qs = params.toString();
    const result = await api.get(`/analytics/stale-leads${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

// ==================== WRITE TOOLS ====================

server.tool(
  "update_lead",
  "Update a lead's details (stage, contact info, pricing)",
  {
    leadId: z.string().describe("The lead ID"),
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
  async ({ leadId, ...updates }) => {
    const result = await api.patch(`/leads/${leadId}`, updates);
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "create_lead",
  "Create a new lead from a property ref ID",
  {
    refId: z
      .string()
      .describe(
        "The property reference ID — dashes are optional (e.g. PBCS10152063 or PB-CS-1015-2063)",
      ),
  },
  async ({ refId }) => {
    const result = await api.post("/leads", { refId });
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "delete_lead",
  "Soft-delete a lead",
  {
    leadId: z.string().describe("The lead ID"),
  },
  async ({ leadId }) => {
    await api.delete(`/leads/${leadId}`);
    return { content: [{ type: "text" as const, text: "Lead deleted" }] };
  },
);

server.tool(
  "add_contact_note",
  "Add a note to a lead",
  {
    leadId: z.string().describe("The lead ID"),
    content: z.string().describe("The note content"),
  },
  async ({ leadId, content }) => {
    const result = await api.post(`/leads/${leadId}/contact-notes`, { content });
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

// ==================== IMAGE TOOLS ====================

server.tool(
  "list_lead_images",
  "List all screenshots/images attached to a lead",
  {
    leadId: z.string().describe("The lead ID"),
  },
  async ({ leadId }) => {
    const images = await api.get(`/leads/${leadId}/images`);
    if (!images || (Array.isArray(images) && images.length === 0))
      return { content: [{ type: "text" as const, text: "No images found for this lead" }] };
    return { content: [{ type: "text" as const, text: json(images) }] };
  },
);

server.tool(
  "upload_lead_image",
  "Upload a screenshot or image to a lead from a local file path",
  {
    leadId: z.string().describe("The lead ID"),
    filePath: z.string().describe("Absolute path to the image file on disk"),
    description: z.string().optional().describe("Optional description of the screenshot"),
  },
  async ({ leadId, filePath, description }) => {
    if (!existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: "File not found: " + filePath }] };
    }

    const fields: Record<string, string> = {};
    if (description) fields.description = description;

    const result = await api.upload(`/leads/${leadId}/images`, filePath, fields);
    return { content: [{ type: "text" as const, text: json(result) }] };
  },
);

server.tool(
  "delete_lead_image",
  "Delete a screenshot/image from a lead",
  {
    imageId: z.string().describe("The image ID"),
  },
  async ({ imageId }) => {
    await api.delete(`/leads/images/${imageId}`);
    return { content: [{ type: "text" as const, text: "Image deleted" }] };
  },
);

// ==================== CAMPAIGN TOOLS ====================

server.tool(
  "edit_campaign",
  "Update a campaign name",
  {
    campaignId: z.string().describe("The campaign ID"),
    name: z.string().describe("New campaign name"),
  },
  async ({ campaignId, name }) => {
    await api.patch(`/campaigns/${campaignId}`, { name });
    return { content: [{ type: "text" as const, text: "Campaign updated" }] };
  },
);

server.tool(
  "delete_campaign",
  "Soft-delete a campaign",
  {
    campaignId: z.string().describe("The campaign ID"),
  },
  async ({ campaignId }) => {
    await api.delete(`/campaigns/${campaignId}`);
    return { content: [{ type: "text" as const, text: "Campaign deleted" }] };
  },
);

// ==================== RESOURCES ====================

server.resource("organization", "landbridge://organization", async (uri) => {
  const org = await api.get("/organization");
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: json(org) },
    ],
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
