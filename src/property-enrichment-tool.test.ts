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
  body: unknown;
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
  const client = new Client({ name: "property-enrichment-test", version: "1.0.0" });
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

test("update_property_enrichment writes markdown for one company and stamps enrichedAt", async () => {
  const started = Date.now();
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, {
          crossOrg: true,
          organizations: [
            { organizationId: "org-north", name: "North" },
            { organizationId: "org-south", name: "South" },
          ],
        });
        return;
      }
      if (seen.method === "PATCH" && seen.path === "/properties/prop_1/enrichment") {
        json(res, 200, {
          id: "prop_1",
          organizationId: "org-south",
          enrichmentMarkdown: "# Public records\n\nOwner is on file.",
          enrichedAt: (seen.body as { enrichedAt?: string }).enrichedAt,
        });
        return;
      }
      json(res, 500, { message: `unexpected ${seen.method} ${seen.path}` });
    },
    async (client, calls) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === "update_property_enrichment");
      assert.ok(tool);
      for (const field of ["propertyId", "enrichmentMarkdown"]) {
        assert.ok(tool.inputSchema.required?.includes(field));
      }
      assert.equal(tool.inputSchema.required?.includes("organizationId"), false);

      const refused = await client.callTool({
        name: "update_property_enrichment",
        arguments: {
          propertyId: "prop_1",
          enrichmentMarkdown: "# Public records\n\nOwner is on file.",
        },
      });
      assert.equal(refused.isError, true);
      const refusedText = JSON.parse((refused.content as Array<{ text: string }>)[0].text) as {
        error: string;
      };
      assert.equal(refusedText.error, "ORGANIZATION_REQUIRED");
      assert.equal(
        calls.some((call) => call.method === "PATCH"),
        false,
      );

      const result = await client.callTool({
        name: "update_property_enrichment",
        arguments: {
          propertyId: " prop_1 ",
          enrichmentMarkdown: "# Public records\n\nOwner is on file.",
          organizationId: "org-south",
        },
      });
      assert.equal(result.isError, undefined);
      const saved = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
        id: string;
        enrichmentMarkdown: string;
        enrichedAt: string;
      };
      assert.equal(saved.id, "prop_1");
      assert.equal(saved.enrichmentMarkdown, "# Public records\n\nOwner is on file.");

      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.path, "/properties/prop_1/enrichment");
      assert.equal(patch.org, "org-south");
      const body = patch.body as {
        enrichmentMarkdown: string;
        enrichedAt: string;
        organizationId: string;
      };
      assert.deepEqual(
        {
          enrichmentMarkdown: body.enrichmentMarkdown,
          organizationId: body.organizationId,
        },
        {
          enrichmentMarkdown: "# Public records\n\nOwner is on file.",
          organizationId: "org-south",
        },
      );
      assert.equal(Object.keys(body).sort().join(","), "enrichedAt,enrichmentMarkdown,organizationId");
      const stamped = Date.parse(body.enrichedAt);
      assert.equal(Number.isNaN(stamped), false);
      assert.ok(stamped >= started - 1000);
      assert.ok(stamped <= Date.now() + 1000);
      assert.equal(saved.enrichedAt, body.enrichedAt);
    },
  );
});

test("a single-org key writes enrichment on the home company without an organization id", async () => {
  await withMcp(
    (_req, res, seen) => {
      if (seen.path === "/cross-org/organizations") {
        json(res, 200, {
          crossOrg: false,
          organizations: [{ organizationId: "org-home", name: "Home" }],
        });
        return;
      }
      if (seen.method === "PATCH" && seen.path === "/properties/prop_home/enrichment") {
        json(res, 200, { id: "prop_home", enrichmentMarkdown: "Note", enrichedAt: "stamped" });
        return;
      }
      json(res, 404, { message: "Property not found", code: "NOT_FOUND" });
    },
    async (client, calls) => {
      const result = await client.callTool({
        name: "update_property_enrichment",
        arguments: { propertyId: "prop_home", enrichmentMarkdown: "Note" },
      });
      assert.equal(result.isError, undefined);
      const patch = calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.equal(patch.org, undefined);
      const body = patch.body as Record<string, unknown>;
      assert.equal(body.enrichmentMarkdown, "Note");
      assert.equal("organizationId" in body, false);
      assert.equal(typeof body.enrichedAt, "string");

      const missing = await client.callTool({
        name: "update_property_enrichment",
        arguments: { propertyId: "prop_other", enrichmentMarkdown: "Note" },
      });
      assert.equal(missing.isError, true);
      const text = (missing.content as Array<{ text: string }>)[0].text;
      assert.match(text, /Property not found/);
    },
  );
});
