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
      if (seen.method === "PATCH" && seen.path === encodedLeadPath) {
        json(res, 200, { leadId: "lead/1?v=2", apn: "12/34", status: "IN_PROGRESS" });
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
      assert.equal(maxLength(findSchema(tool.inputSchema, "legalDescription")), MAX_DD_LONG_TEXT);

      const refused = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead/1?v=2", apn: "12/34", status: "IN_PROGRESS" },
      });
      assert.equal(refused.isError, true);
      assert.equal(errorCode(refused), "ORGANIZATION_REQUIRED");
      assert.equal(calls.some((call) => call.method === "PATCH"), false);

      const missingParcel = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead/1?v=2", status: "IN_PROGRESS", organizationId: "org-south" },
      });
      assert.equal(missingParcel.isError, true);
      assert.equal(errorCode(missingParcel), "PARCEL_REQUIRED");

      const missingFields = await client.callTool({
        name: "upsert_due_diligence",
        arguments: { leadId: "lead/1?v=2", apn: "12/34", organizationId: "org-south" },
      });
      assert.equal(missingFields.isError, true);
      assert.equal(errorCode(missingFields), "DUE_DILIGENCE_FIELDS_REQUIRED");
      assert.equal(calls.some((call) => call.method === "PATCH"), false);

      const result = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: " lead/1?v=2 ",
          propertyId: "prop_9",
          apn: " 12/34 ",
          status: "IN_PROGRESS",
          parcel: { acreage: 5.25 },
          title: { ownerOfRecord: "Ada Lovelace" },
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
        apn: "12/34",
        propertyId: "prop_9",
        status: "IN_PROGRESS",
        parcel: { acreage: 5.25 },
        title: { ownerOfRecord: "Ada Lovelace" },
        restrictions: { hoa: false, strAllowed: true },
        organizationId: "org-south",
      });
    },
  );
});

test("upsert_due_diligence rejects oversized text and payloads before calling the API", async () => {
  await withMcp(
    (_req, res, seen) => {
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tooLong = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          apn: "12-34",
          parcel: { legalDescription: "a".repeat(MAX_DD_LONG_TEXT + 1) },
          organizationId: "org-south",
        },
      });
      assert.equal(tooLong.isError, true);
      assert.match(textOf(tooLong), new RegExp(`${MAX_DD_LONG_TEXT}|too_big|max`, "i"));

      const long = "b".repeat(MAX_DD_LONG_TEXT);
      const tooBig = await client.callTool({
        name: "upsert_due_diligence",
        arguments: {
          leadId: "lead_1",
          apn: "12-34",
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
        arguments: { leadId: "lead_home", apn: "9", status: "COMPLETE" },
      });
      assert.equal(result.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.org, undefined);
      const body = patch.body as Record<string, unknown>;
      assert.equal(body.status, "COMPLETE");
      assert.equal(body.apn, "9");
      assert.equal("organizationId" in body, false);

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
        json(res, 200, { leadId: "lead/1?v=2", parcels: [{ apn: "12/34", status: "IN_PROGRESS" }] });
        return;
      }
      if (seen.path.startsWith("/properties/prop%2F2/due-diligence")) {
        json(res, 200, { propertyId: "prop/2", parcels: [] });
        return;
      }
      if (seen.path.startsWith("/leads/missing/due-diligence")) {
        json(res, seen.org === "org-south" ? 200 : 404, {
          ...(seen.org === "org-south"
            ? { parcels: [{ apn: "1" }] }
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
        arguments: { leadId: " lead/1?v=2 ", apn: "12/34", organizationId: "org-south" },
      });
      assert.equal(one.isError, undefined);
      const leadGet = calls.find((call) => call.path.startsWith("/leads/lead%2F1"));
      assert.ok(leadGet);
      assert.equal(leadGet.method, "GET");
      assert.equal(leadGet.org, "org-south");
      assert.match(leadGet.path, /^\/leads\/lead%2F1%3Fv%3D2\/due-diligence\?/);
      assert.match(leadGet.path, /apn=12%2F34/);
      assert.match(leadGet.path, /organizationId=org-south/);
      const leadBody = JSON.parse(textOf(one)) as { parcels: Array<{ apn: string }> };
      assert.equal(leadBody.parcels[0].apn, "12/34");

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

test("add_dd_comp and update_dd_item encode ids and send only the comp or item", async () => {
  const compsPath = "/leads/lead%2F1/due-diligence/comps";
  const itemPath = "/leads/lead_1/due-diligence/items/item%2F9%3Fx%3D1";
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "POST" && seen.path === compsPath) {
        json(res, 200, { comps: [{ address: "100 County Road" }] });
        return;
      }
      if (seen.method === "PATCH" && seen.path === itemPath) {
        json(res, 200, { openItems: [{ id: "item/9?x=1", status: "VERIFIED" }] });
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

      const comp = await client.callTool({
        name: "add_dd_comp",
        arguments: {
          leadId: "lead/1",
          propertyId: "prop_9",
          apn: "12/34",
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
      const post = calls.find((call) => call.method === "POST");
      assert.ok(post);
      assert.equal(post.path, compsPath);
      assert.equal(post.org, "org-south");
      assert.deepEqual(post.body, {
        apn: "12/34",
        propertyId: "prop_9",
        address: "100 County Road",
        acres: 5,
        price: 25000,
        date: "2024-06-01",
        status: "SOLD",
        url: "https://example.com/comp",
        organizationId: "org-south",
      });

      const item = await client.callTool({
        name: "update_dd_item",
        arguments: {
          leadId: "lead_1",
          apn: "12/34",
          itemId: " item/9?x=1 ",
          kind: "open_item",
          status: "VERIFIED",
          sourceUrl: "https://example.com/deed",
          organizationId: "org-south",
        },
      });
      assert.equal(item.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.path, itemPath);
      assert.equal(patch.org, "org-south");
      assert.deepEqual(patch.body, {
        apn: "12/34",
        kind: "open_item",
        status: "VERIFIED",
        sourceUrl: "https://example.com/deed",
        organizationId: "org-south",
      });
    },
  );
});

test("list_leads and search_leads forward due diligence filters", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, CROSS_ORGS);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/leads?")) {
        json(res, 200, [{ id: "lead_1" }]);
        return;
      }
      if (seen.method === "GET" && seen.path.startsWith("/cross-org/leads/search")) {
        json(res, 200, { leads: [{ id: "lead_1", name: "Ada" }] });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const reversed = await client.callTool({
        name: "list_leads",
        arguments: { valueMin: 5, valueMax: 1, organizationId: "org-south" },
      });
      assert.equal(reversed.isError, true);
      assert.equal(errorCode(reversed), "VALUE_RANGE_INVALID");

      const searchReversed = await client.callTool({
        name: "search_leads",
        arguments: { query: "Ada", valueMin: 9, valueMax: 1 },
      });
      assert.equal(searchReversed.isError, true);
      assert.equal(errorCode(searchReversed), "VALUE_RANGE_INVALID");
      assert.equal(
        calls.some((call) => call.path.startsWith("/leads") || call.path.includes("/search")),
        false,
      );

      const listed = await client.callTool({
        name: "list_leads",
        arguments: {
          ddStatus: "IN_PROGRESS",
          valueMin: 10000,
          valueMax: 50000,
          organizationId: "org-south",
        },
      });
      assert.equal(listed.isError, undefined);
      const list = calls.find((call) => call.path.startsWith("/leads?"));
      assert.ok(list);
      assert.equal(list.org, "org-south");
      assert.match(list.path, /ddStatus=IN_PROGRESS/);
      assert.match(list.path, /valueMin=10000/);
      assert.match(list.path, /valueMax=50000/);
      assert.match(list.path, /organizationId=org-south/);

      const searched = await client.callTool({
        name: "search_leads",
        arguments: { query: "Ada", ddStatus: "COMPLETE", valueMin: 0, valueMax: 20, organizationId: "org-north" },
      });
      assert.equal(searched.isError, undefined);
      const search = calls.find((call) => call.path.startsWith("/cross-org/leads/search"));
      assert.ok(search);
      assert.equal(search.org, "org-north");
      assert.match(search.path, /query=Ada/);
      assert.match(search.path, /ddStatus=COMPLETE/);
      assert.match(search.path, /valueMin=0/);
      assert.match(search.path, /valueMax=20/);

      await client.callTool({
        name: "search_leads",
        arguments: { query: "Grace" },
      });
      const plain = calls.find((call) => call.path.startsWith("/cross-org/leads/search") && call.path.includes("Grace"));
      assert.ok(plain);
      assert.equal(plain.path.includes("ddStatus"), false);
      assert.equal(plain.path.includes("valueMin"), false);
      assert.equal(plain.path.includes("valueMax"), false);
    },
  );
});
