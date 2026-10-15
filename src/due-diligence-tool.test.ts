import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_DD_LONG_TEXT, MAX_DUE_DILIGENCE_JSON_CHARS } from "./due-diligence.js";

type SeenRequest = {
  method: string;
  path: string;
  org: string | undefined;
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
  const client = new Client({ name: "due-diligence-test", version: "1.0.0" });
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

function errorCode(result: unknown): string {
  return (JSON.parse(textOf(result)) as { error: string }).error;
}

function findSchema(node: unknown, name: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    const props = record.properties as Record<string, unknown>;
    if (props[name] && typeof props[name] === "object") return props[name] as Record<string, unknown>;
    for (const child of Object.values(props)) {
      const found = findSchema(child, name);
      if (found) return found;
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(record[key])) continue;
    for (const child of record[key] as unknown[]) {
      const found = findSchema(child, name);
      if (found) return found;
    }
  }
  return undefined;
}

function maxLength(schema: Record<string, unknown> | undefined): number | undefined {
  if (!schema) return undefined;
  if (typeof schema.maxLength === "number") return schema.maxLength;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[key])) continue;
    for (const child of schema[key] as unknown[]) {
      if (!child || typeof child !== "object") continue;
      const found = maxLength(child as Record<string, unknown>);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

test("upsert_due_diligence writes a partial parcel record for one company", async () => {
  const encodedLeadPath = "/leads/lead%2F1%3Fv%3D2/due-diligence";
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "PATCH" && (seen.path === encodedLeadPath || seen.path === "/leads/lead_only/due-diligence")) {
        json(res, 200, { revision: 4, status: "IN_PROGRESS" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === "upsert_due_diligence");
      assert.ok(tool);
      assert.equal(tool.inputSchema.required?.includes("organizationId") ?? false, false);
      assert.equal(tool.inputSchema.required?.includes("leadId") ?? false, false);
      assert.equal(tool.inputSchema.required?.includes("parcelApn") ?? false, false);
      assert.equal(maxLength(findSchema(tool.inputSchema, "legalDescription")), MAX_DD_LONG_TEXT);
      const seller = findSchema(tool.inputSchema, "seller");
      assert.ok(seller);
      const sellerValues = JSON.stringify(seller);
      for (const value of ["OWNER", "SPOUSE", "HEIR", "ENTITY", "OTHER"]) {
        assert.match(sellerValues, new RegExp(value));
      }

      const refused = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead/1?v=2", parcelApn: "12/34", status: "IN_PROGRESS" },
      });
      assert.equal(refused.isError, true);
      assert.equal(errorCode(refused), "ORGANIZATION_REQUIRED");
      assert.equal(calls.some((call) => call.method === "PATCH"), false);

      const missingFields = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead/1?v=2", parcelApn: "12/34", organizationId: "org-south" },
      });
      assert.equal(missingFields.isError, true);
      assert.equal(errorCode(missingFields), "DUE_DILIGENCE_FIELDS_REQUIRED");
      assert.equal(calls.some((call) => call.method === "PATCH"), false);

      const result = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: " lead/1?v=2 ",
          propertyId: "prop_9",
          parcelApn: " 12/34 ",
          expectedRevision: 3,
          status: "IN_PROGRESS",
          parcel: { acreage: 5.25 },
          title: {
            ownerOfRecord: "Ada Lovelace",
            seller: "OWNER",
            deedDate: "1998-03-02",
            deedPrice: "15000.5",
          },
          values: { trustee: "PAID", taxAmount: 240 },
          access: { road: "GRAVEL", maintenance: "COUNTY" },
          restrictions: { hoa: false, strAllowed: true },
          organizationId: "org-south",
        },
      });
      assert.equal(result.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.path, encodedLeadPath);
      assert.equal(patch.org, "org-south");
      assert.deepEqual(patch.body, {
        parcelApn: "12/34",
        propertyId: "prop_9",
        expectedRevision: 3,
        status: "IN_PROGRESS",
        parcel: { acreage: 5.25 },
        title: {
          ownerOfRecord: "Ada Lovelace",
          seller: "OWNER",
          deedDate: "1998-03-02",
          deedPrice: "15000.50",
        },
        values: { trustee: "PAID", taxAmount: "240.00" },
        access: { road: "GRAVEL", maintenance: "COUNTY" },
        restrictions: { hoa: false, strAllowed: true },
        organizationId: "org-south",
      });

      const oneParcel = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead_only", status: "PASS", expectedRevision: 0, organizationId: "org-south" },
      });
      assert.equal(oneParcel.isError, undefined);
      const solo = calls.filter((call) => call.method === "PATCH").at(-1);
      assert.ok(solo);
      assert.equal(solo.path, "/leads/lead_only/due-diligence");
      assert.deepEqual(solo.body, {
        status: "PASS",
        expectedRevision: 0,
        organizationId: "org-south",
      });
    },
  );
});

test("upsert_due_diligence rejects oversized text, bad dates, and payloads before calling the API", async () => {
  await withMcp(
    (_req, res, seen) => {
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tooLong = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          parcelApn: "12-34",
          parcel: { legalDescription: "a".repeat(MAX_DD_LONG_TEXT + 1) },
          organizationId: "org-south",
        },
      });
      assert.equal(tooLong.isError, true);
      assert.match(textOf(tooLong), new RegExp(`${MAX_DD_LONG_TEXT}|too_big|max`, "i"));

      const badDate = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          title: { deedDate: "03/02/1998" },
          organizationId: "org-south",
        },
      });
      assert.equal(badDate.isError, true);
      assert.match(textOf(badDate), /YYYY-MM-DD|invalid|date/i);

      const impossible = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          title: { deedDate: "2024-02-31" },
          organizationId: "org-south",
        },
      });
      assert.equal(impossible.isError, true);

      const long = "b".repeat(MAX_DD_LONG_TEXT);
      const tooBig = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          parcelApn: "12-34",
          parcel: { legalDescription: long },
          title: { authorityNotes: long },
          access: { notes: long },
          restrictions: { covenants: long },
          valuation: { rationale: long },
          organizationId: "org-south",
        },
      });
      assert.equal(tooBig.isError, true);
      assert.equal(errorCode(tooBig), "DUE_DILIGENCE_TOO_LARGE");
      assert.match(textOf(tooBig), new RegExp(String(MAX_DUE_DILIGENCE_JSON_CHARS)));
      assert.equal(calls.length, 0);
    },
  );
});

test("a stale expectedRevision surfaces 409 DD_CONFLICT", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "PATCH" && seen.path === "/leads/lead_1/due-diligence") {
        json(res, 409, { code: "DD_CONFLICT", message: "stale revision", revision: 8 });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client) => {
      const result = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          status: "IN_PROGRESS",
          expectedRevision: 3,
          organizationId: "org-south",
        },
      });
      assert.equal(result.isError, true);
      const body = JSON.parse(textOf(result)) as {
        error: string;
        message: string;
        status: number;
        details: { revision: number; message: string };
      };
      assert.equal(body.error, "DD_CONFLICT");
      assert.equal(body.status, 409);
      assert.match(body.message, /expectedRevision/);
      assert.match(body.message, /stale revision/);
      assert.equal(body.details.revision, 8);
      assert.equal(textOf(result).includes("REQUEST_FAILED"), false);
    },
  );
});

test("a single-org key writes due diligence on the home company without an organization id", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, {
          crossOrg: false,
          organizations: [{ organizationId: "org-home", name: "Home" }],
        });
        return;
      }
      if (seen.method === "PATCH" && seen.path === "/leads/lead_home/due-diligence") {
        json(res, 200, { leadId: "lead_home", status: "COMPLETE" });
        return;
      }
      json(res, 404, { message: "Lead not found", code: "NOT_FOUND" });
    },
    async (client, calls) => {
      const result = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead_home", parcelApn: "9", status: "COMPLETE" },
      });
      assert.equal(result.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.org, undefined);
      const body = patch.body as Record<string, unknown>;
      assert.equal(body.status, "COMPLETE");
      assert.equal(body.parcelApn, "9");
      assert.equal("organizationId" in body, false);
      assert.equal("expectedRevision" in body, false);

      const missing = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { propertyId: "prop_other", status: "PASS" },
      });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /Lead not found/);
    },
  );
});

test("a parcel with no lead uses the property due diligence route", async () => {
  const encoded = "/properties/prop%2F1%3Fv%3D2/due-diligence";
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "PATCH" && seen.path === encoded) {
        json(res, 200, { propertyId: "prop/1?v=2", status: "NOT_STARTED" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const result = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          propertyId: " prop/1?v=2 ",
          status: "NOT_STARTED",
          organizationId: "org-north",
        },
      });
      assert.equal(result.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.path, encoded);
      assert.equal(patch.org, "org-north");
      assert.deepEqual(patch.body, {
        status: "NOT_STARTED",
        organizationId: "org-north",
      });
    },
  );
});

test("get_due_diligence encodes ids and can check every company", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method !== "GET") {
        json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
        return;
      }
      if (seen.path.startsWith("/leads/lead%2F1%3Fv%3D2/due-diligence")) {
        json(res, 200, { leadId: "lead/1?v=2", parcels: [{ parcelApn: "12/34", status: "IN_PROGRESS" }] });
        return;
      }
      if (seen.path.startsWith("/properties/prop%2F2/due-diligence")) {
        json(res, 200, { propertyId: "prop/2", parcels: [] });
        return;
      }
      if (seen.path.startsWith("/leads/missing/due-diligence")) {
        json(res, seen.org === "org-south" ? 200 : 404, {
          ...(seen.org === "org-south"
            ? { parcels: [{ parcelApn: "1" }] }
            : { message: "Lead not found", code: "NOT_FOUND" }),
        });
        return;
      }
      if (seen.path.startsWith("/leads/absent/due-diligence")) {
        json(res, 404, { message: "Lead not found", code: "NOT_FOUND" });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const one = await client.callTool({
        name: "get_due_diligence",
        arguments: { leadId: " lead/1?v=2 ", parcelApn: "12/34", organizationId: "org-south" },
      });
      assert.equal(one.isError, undefined);
      const leadGet = calls.find((call) => call.path.startsWith("/leads/lead%2F1"));
      assert.ok(leadGet);
      assert.equal(leadGet.method, "GET");
      assert.equal(leadGet.org, "org-south");
      assert.match(leadGet.path, /^\/leads\/lead%2F1%3Fv%3D2\/due-diligence\?/);
      assert.match(leadGet.path, /parcelApn=12%2F34/);
      assert.match(leadGet.path, /organizationId=org-south/);
      const leadBody = JSON.parse(textOf(one)) as { parcels: Array<{ parcelApn: string }> };
      assert.equal(leadBody.parcels[0].parcelApn, "12/34");

      const parcel = await client.callTool({
        name: "get_due_diligence",
        arguments: { propertyId: " prop/2 ", organizationId: "org-north" },
      });
      assert.equal(parcel.isError, undefined);
      const propertyGet = calls.find((call) => call.path.startsWith("/properties/prop%2F2"));
      assert.ok(propertyGet);
      assert.equal(propertyGet.org, "org-north");
      assert.match(propertyGet.path, /^\/properties\/prop%2F2\/due-diligence\?/);

      const found = await client.callTool({
        name: "get_due_diligence",
        arguments: { leadId: "missing" },
      });
      assert.equal(found.isError, undefined);
      const fanout = calls.filter((call) => call.path.startsWith("/leads/missing/due-diligence"));
      assert.deepEqual(
        fanout.map((call) => call.org).sort(),
        ["org-north", "org-south"],
      );
      const hit = JSON.parse(textOf(found)) as { organizationName?: string; parcels: unknown[] };
      assert.equal(hit.organizationName, "South");
      assert.equal(hit.parcels.length, 1);

      const absent = await client.callTool({
        name: "get_due_diligence",
        arguments: { leadId: "absent" },
      });
      assert.equal(absent.isError, undefined);
      assert.match(textOf(absent), /Due diligence not found in any company/);

      const neither = await client.callTool({
        name: "get_due_diligence",
        arguments: {},
      });
      assert.equal(neither.isError, true);
      assert.equal(errorCode(neither), "TARGET_REQUIRED");
    },
  );
});

test("add_dd_comp and update_dd_item patch the due diligence record", async () => {
  const leadPath = "/leads/lead%2F1/due-diligence";
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "PATCH" && seen.path === leadPath) {
        json(res, 200, { revision: 5 });
        return;
      }
      if (seen.method === "PATCH" && seen.path === "/leads/lead_1/due-diligence") {
        json(res, 200, { revision: 6 });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tools = await client.listTools();
      const compTool = tools.tools.find((entry) => entry.name === "add_dd_comp");
      const itemTool = tools.tools.find((entry) => entry.name === "update_dd_item");
      assert.ok(compTool);
      assert.ok(itemTool);
      assert.ok(compTool.inputSchema.required?.includes("address"));
      assert.equal(compTool.inputSchema.required?.includes("organizationId"), false);
      for (const field of ["itemId", "status"]) {
        assert.ok(itemTool.inputSchema.required?.includes(field));
      }
      const kind = JSON.stringify(findSchema(itemTool.inputSchema, "kind"));
      assert.match(kind, /RISK/);
      assert.match(kind, /OPEN_ITEM/);

      const comp = await client.callTool({
        name: "add_dd_comp",
        arguments: {
          leadId: "lead/1",
          propertyId: "prop_9",
          parcelApn: "12/34",
          expectedRevision: 4,
          address: "100 County Road",
          acres: 5,
          price: 25000,
          date: "2024-06-01",
          status: "SOLD",
          url: "https://example.com/comp",
          organizationId: "org-south",
        },
      });
      assert.equal(comp.isError, undefined);
      const compPatch = calls.find((call) => call.method === "PATCH" && call.path === leadPath);
      assert.ok(compPatch);
      assert.equal(compPatch.org, "org-south");
      assert.equal(calls.some((call) => call.path.endsWith("/comps")), false);
      assert.deepEqual(compPatch.body, {
        parcelApn: "12/34",
        propertyId: "prop_9",
        expectedRevision: 4,
        comps: {
          add: [
            {
              address: "100 County Road",
              acres: 5,
              price: "25000.00",
              date: "2024-06-01",
              status: "SOLD",
              url: "https://example.com/comp",
            },
          ],
        },
        organizationId: "org-south",
      });

      const item = await client.callTool({
        name: "update_dd_item",
        arguments: {
          leadId: "lead_1",
          parcelApn: "12/34",
          itemId: " item/9?x=1 ",
          kind: "OPEN_ITEM",
          status: "VERIFIED",
          sourceUrl: "https://example.com/deed",
          expectedRevision: 5,
          organizationId: "org-south",
        },
      });
      assert.equal(item.isError, undefined);
      const itemPatch = calls.find((call) => call.method === "PATCH" && call.path === "/leads/lead_1/due-diligence");
      assert.ok(itemPatch);
      assert.equal(itemPatch.org, "org-south");
      assert.equal(calls.some((call) => call.path.includes("/items/")), false);
      assert.deepEqual(itemPatch.body, {
        parcelApn: "12/34",
        expectedRevision: 5,
        items: {
          update: [
            {
              itemId: "item/9?x=1",
              kind: "OPEN_ITEM",
              status: "VERIFIED",
              sourceUrl: "https://example.com/deed",
            },
          ],
        },
        organizationId: "org-south",
      });
    },
  );
});
