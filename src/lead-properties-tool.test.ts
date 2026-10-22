import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type SeenRequest = {
  method: string;
  path: string;
  org: string | undefined;
  apiKey: string | undefined;
  body: unknown;
};

const CROSS_ORGS = {
  crossOrg: true,
  organizations: [
    { organizationId: "org-north", name: "North" },
    { organizationId: "org-south", name: "South" },
  ],
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

async function withMcp(
  handler: (req: IncomingMessage, res: ServerResponse, seen: SeenRequest) => void,
  run: (client: Client, calls: SeenRequest[]) => Promise<void>,
) {
  const calls: SeenRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    const seen: SeenRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      org: req.headers["x-organization-id"] as string | undefined,
      apiKey: req.headers["x-api-key"] as string | undefined,
      body,
    };
    calls.push(seen);
    handler(req, res, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./index.js", import.meta.url))],
    env: { MCP_API_KEY: "test-only", MCP_API_URL: `http://127.0.0.1:${address.port}` },
    stderr: "pipe",
  });
  const client = new Client({ name: "lead-properties-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await run(client, calls);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content[0].text;
}

test("get_lead returns every property linked to the lead and sums parcel pricing", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads/lead%2F1/properties")) {
        assert.equal(seen.org, "org-south");
        assert.equal(seen.apiKey, "test-only");
        assert.match(seen.path, /organizationId=org-south/);
        json(res, 200, {
          properties: [
            {
              id: "p1",
              apn: "18-27-33-2720-0001-1950",
              county: "Osceola",
              state: "FL",
              offerPrice: 1000,
              purchasePrice: 900,
              sellingPrice: 1500,
            },
            {
              id: "p2",
              apn: "08-44-27-L3-02007.0150",
              county: "Lee",
              state: "FL",
              refId: "HOL-301-95",
              offerPrice: 2000,
              purchasePrice: 1800,
              sellingPrice: 2500,
            },
          ],
        });
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads/lead%2F1")) {
        if (seen.org === "org-south") {
          json(res, 200, {
            id: "lead/1",
            name: "Paula M Riley",
            property: {
              id: "p1",
              apn: "18-27-33-2720-0001-1950",
              county: "Osceola",
              state: "FL",
              offerPrice: 1000,
            },
          });
          return;
        }
        json(res, 404, { message: "Not found", code: "NOT_FOUND" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_lead",
        arguments: { leadId: "lead/1" },
      });
      assert.equal(result.isError, undefined, textOf(result));
      const lead = JSON.parse(textOf(result)) as Record<string, unknown>;
      const properties = lead.properties as Array<Record<string, unknown>>;
      assert.equal(properties.length, 2);
      assert.equal(properties[0].apn, "18-27-33-2720-0001-1950");
      assert.equal(properties[1].county, "Lee");
      assert.equal(properties[1].organizationId, "org-south");
      assert.equal(properties[1].organizationName, "South");
      const pricing = lead.pricing as Record<string, unknown>;
      assert.equal(pricing.offerPrice, 3000);
      assert.equal(pricing.purchasePrice, 2700);
      assert.equal(pricing.sellingPrice, 4000);
      assert.equal(pricing.propertyCount, 2);
      assert.equal(lead.propertiesNote, undefined);
    },
  );
});

test("get_lead keeps an embedded properties array and does not invent parcels when the list route is missing", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, {
          crossOrg: false,
          organizations: [{ organizationId: "org-home", name: "Home" }],
        });
        return;
      }
      if (
        seen.path.startsWith("/leads/lead_embedded/properties") ||
        seen.path.startsWith("/leads/lead_legacy/properties")
      ) {
        json(res, 404, { message: `Cannot GET ${seen.path.split("?")[0]}` });
        return;
      }
      if (seen.path.startsWith("/leads/lead_embedded")) {
        json(res, 200, {
          id: "lead_embedded",
          name: "Ada Lovelace",
          property: { id: "p1", apn: "1", offerPrice: 10 },
          properties: [
            { id: "p1", apn: "1", offerPrice: 10 },
            { id: "p2", apn: "2", purchasePrice: 4 },
          ],
        });
        return;
      }
      if (seen.path.startsWith("/leads/lead_legacy")) {
        json(res, 200, {
          id: "lead_legacy",
          name: "Grace Hopper",
          property: { id: "only", apn: "9", sellingPrice: 8 },
        });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const embedded = await client.callTool({
        name: "get_lead",
        arguments: { leadId: "lead_embedded" },
      });
      assert.equal(embedded.isError, undefined, textOf(embedded));
      const lead = JSON.parse(textOf(embedded)) as {
        properties: Array<{ id: string }>;
        pricing: { offerPrice?: number; purchasePrice?: number; propertyCount: number };
        propertiesNote?: string;
      };
      assert.deepEqual(
        lead.properties.map((property) => property.id),
        ["p1", "p2"],
      );
      assert.equal(lead.pricing.offerPrice, 10);
      assert.equal(lead.pricing.purchasePrice, 4);
      assert.equal(lead.pricing.propertyCount, 2);
      assert.equal(lead.propertiesNote, undefined);
      assert.equal(
        calls.some((call) => call.path.includes("/leads/lead_embedded/properties")),
        false,
      );

      const legacyCalls = calls.length;
      const legacy = await client.callTool({
        name: "get_lead",
        arguments: { leadId: "lead_legacy" },
      });
      assert.equal(legacy.isError, undefined, textOf(legacy));
      const one = JSON.parse(textOf(legacy)) as {
        properties: Array<{ id: string; organizationId?: string }>;
        pricing: { sellingPrice: number };
        propertiesNote?: string;
      };
      assert.equal(one.properties.length, 1);
      assert.equal(one.properties[0].id, "only");
      assert.equal(one.pricing.sellingPrice, 8);
      assert.match(String(one.propertiesNote), /GET \/leads\/\{leadId\}\/properties/);
      assert.ok(calls.slice(legacyCalls).some((call) => call.path.includes("/leads/lead_legacy/properties")));
    },
  );
});

test("add_property_to_lead creates or links a parcel on an existing lead", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads/lead%2F1")) {
        if (seen.org === "org-south") {
          json(res, 200, { id: "lead/1", name: "Paula M Riley", organizationId: "org-south" });
          return;
        }
        json(res, 404, { message: "Not found", code: "NOT_FOUND" });
        return;
      }
      if (seen.method === "POST" && seen.path === "/leads/lead%2F1/properties") {
        json(res, 200, { leadId: "lead/1", propertyId: "p_new", ...(seen.body as object) });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === "add_property_to_lead");
      assert.ok(tool);
      assert.ok(tool.inputSchema.required?.includes("leadId"));
      assert.equal(tool.inputSchema.required?.includes("organizationId"), false);

      const byRef = await client.callTool({
        name: "add_property_to_lead",
        arguments: {
          leadId: " lead/1 ",
          refId: " HOL-301-95 ",
          offerPrice: 2000,
          organizationId: "org-south",
        },
      });
      assert.equal(byRef.isError, undefined, textOf(byRef));
      const refPost = calls.find((call) => call.method === "POST");
      assert.ok(refPost);
      assert.equal(refPost.org, "org-south");
      assert.equal(refPost.apiKey, "test-only");
      assert.deepEqual(refPost.body, {
        refId: "HOL-301-95",
        offerPrice: 2000,
        organizationId: "org-south",
      });

      const byApn = await client.callTool({
        name: "add_property_to_lead",
        arguments: {
          leadId: "lead/1",
          apn: "08-44-27-L3-02007.0150",
          county: " Lee ",
          state: " fl ",
          purchasePrice: 1800,
          sellingPrice: 2500,
          organizationId: "org-south",
        },
      });
      assert.equal(byApn.isError, undefined, textOf(byApn));
      const apnPost = calls.filter((call) => call.method === "POST").at(-1);
      assert.deepEqual(apnPost?.body, {
        apn: "08-44-27-L3-02007.0150",
        county: "Lee",
        state: "fl",
        purchasePrice: 1800,
        sellingPrice: 2500,
        organizationId: "org-south",
      });

      const postsBefore = calls.filter((call) => call.method === "POST").length;
      const missing = await client.callTool({
        name: "add_property_to_lead",
        arguments: { leadId: "lead/1", organizationId: "org-south" },
      });
      assert.equal(missing.isError, true);
      assert.equal(JSON.parse(textOf(missing)).error, "PROPERTY_IDENTIFIER_REQUIRED");
      const noCounty = await client.callTool({
        name: "add_property_to_lead",
        arguments: { leadId: "lead/1", apn: "1", state: "FL", organizationId: "org-south" },
      });
      assert.equal(noCounty.isError, true);
      assert.equal(JSON.parse(textOf(noCounty)).error, "COUNTY_AND_STATE_REQUIRED");
      const noOrg = await client.callTool({
        name: "add_property_to_lead",
        arguments: { leadId: "lead/1", refId: "HOL-301-95" },
      });
      assert.equal(noOrg.isError, undefined, textOf(noOrg));
      const defaultPost = calls.filter((call) => call.method === "POST").at(-1);
      assert.equal(defaultPost?.org, "org-south");
      assert.equal(defaultPost?.apiKey, "test-only");
      assert.equal((defaultPost?.body as { organizationId?: string }).organizationId, "org-south");
      assert.ok(
        calls.slice(postsBefore).some(
          (call) => call.method === "GET" && call.path.startsWith("/leads/lead%2F1") && call.org === "org-south",
        ),
      );
    },
  );
});

test("a lead in both companies still requires organizationId", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads/lead_both")) {
        json(res, 200, { id: "lead_both", name: "Paula", organizationId: seen.org });
        return;
      }
      if (seen.method === "POST") {
        json(res, 500, { message: "should not write" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const result = await client.callTool({
        name: "update_lead",
        arguments: { leadId: "lead_both", stage: "NEGOTIATING" },
      });
      assert.equal(result.isError, true);
      const body = JSON.parse(textOf(result)) as { error: string; organizations: unknown[] };
      assert.equal(body.error, "ORGANIZATION_REQUIRED");
      assert.equal(body.organizations.length, 2);
      assert.equal(calls.some((call) => call.method === "POST" || call.method === "PATCH"), false);
    },
  );
});

test("get_lead finds a ref id across companies and flattens lead_property rows", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/cross-org/leads/search")) {
        assert.match(seen.path, /searchBy=refId/);
        assert.match(seen.path, /query=HOL-301-95/);
        assert.equal(seen.org, undefined);
        assert.equal(seen.apiKey, "test-only");
        json(res, 200, {
          leads: [{ id: "lead_paula", organizationId: "org-south" }],
        });
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads/lead_paula")) {
        assert.equal(seen.org, "org-south");
        json(res, 200, {
          id: "lead_paula",
          name: "Paula M Riley",
          organizationId: "org-south",
          properties: [
            {
              id: "link_1",
              leadId: "lead_paula",
              propertyId: "p2",
              offerPrice: 2000,
              purchasePrice: 1800,
              sellingPrice: 2500,
              property: {
                id: "p2",
                apn: "08-44-27-L3-02007.0150",
                county: "Lee",
                state: "FL",
                refId: "HOL-301-95",
              },
            },
          ],
        });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_lead",
        arguments: { refId: "HOL-301-95" },
      });
      assert.equal(result.isError, undefined, textOf(result));
      const lead = JSON.parse(textOf(result)) as {
        name: string;
        organizationId: string;
        organizationName: string;
        properties: Array<Record<string, unknown>>;
        pricing: { offerPrice: number; purchasePrice: number; sellingPrice: number };
      };
      assert.equal(lead.name, "Paula M Riley");
      assert.equal(lead.organizationId, "org-south");
      assert.equal(lead.organizationName, "South");
      assert.equal(lead.properties.length, 1);
      assert.equal(lead.properties[0].id, "p2");
      assert.equal(lead.properties[0].leadPropertyId, "link_1");
      assert.equal(lead.properties[0].apn, "08-44-27-L3-02007.0150");
      assert.equal(lead.properties[0].refId, "HOL-301-95");
      assert.equal(lead.properties[0].offerPrice, 2000);
      assert.equal(lead.pricing.offerPrice, 2000);
      assert.equal(lead.pricing.purchasePrice, 1800);
      assert.equal(lead.pricing.sellingPrice, 2500);
    },
  );
});

test("create_lead uses the company that already has the ref id", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/cross-org/properties/search")) {
        assert.match(seen.path, /searchBy=refId/);
        assert.equal(seen.org, undefined);
        json(res, 200, {
          properties: [
            { id: "parcel_1", refId: "HOL-301-95", organizationId: "org-north" },
          ],
        });
        return;
      }
      if (seen.method === "POST" && seen.path === "/leads") {
        json(res, 200, { id: "lead_new" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const result = await client.callTool({
        name: "create_lead",
        arguments: { refId: "HOL-301-95" },
      });
      assert.equal(result.isError, undefined, textOf(result));
      const post = calls.find((call) => call.method === "POST");
      assert.ok(post);
      assert.equal(post.org, "org-north");
      assert.equal(post.apiKey, "test-only");
      assert.deepEqual(post.body, { refId: "HOL-301-95", organizationId: "org-north" });
    },
  );
});
