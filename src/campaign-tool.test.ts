import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("create_campaign sends its required fields and file through the registered MCP tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-campaign-test-"));
  const uploads: Array<{ org: string | undefined; form: FormData }> = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cross-org/organizations") {
      res.end(
        JSON.stringify({
          crossOrg: true,
          organizations: [{ organizationId: "org-target", name: "Target" }],
        }),
      );
      return;
    }
    if (req.url !== "/campaigns" || req.method !== "POST") {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": req.headers["content-type"]! },
    }).formData();
    uploads.push({ org: req.headers["x-organization-id"] as string, form });
    res.end(JSON.stringify({ campaignId: "new-campaign", organizationId: "org-target" }));
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
  const client = new Client({ name: "campaign-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "create_campaign");
    assert.ok(tool);
    for (const field of ["name", "refId", "filePath"])
      assert.ok(tool.inputSchema.required?.includes(field));
    for (const [extension, mime] of [
      ["csv", "text/csv"],
      ["XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]) {
      const filePath = join(dir, `properties.${extension}`);
      writeFileSync(filePath, "property fixture bytes");
      const result = await client.callTool({
        name: "create_campaign",
        arguments: { name: "Spring", refId: "DNA", filePath, organizationId: "org-target" },
      });
      assert.equal(result.isError, undefined);
      const upload = uploads.at(-1)!;
      assert.equal(upload.org, "org-target");
      assert.equal(upload.form.get("organizationId"), "org-target");
      assert.equal(upload.form.get("name"), "Spring");
      assert.equal(upload.form.get("refId"), "DNA");
      const file = upload.form.get("file") as File;
      assert.equal(file.name, `properties.${extension}`);
      assert.equal(file.type, mime);
      assert.equal(await file.text(), "property fixture bytes");
    }
    const refused = await client.callTool({
      name: "create_campaign",
      arguments: { name: "Spring", refId: "DNA", filePath: join(dir, "properties.csv") },
    });
    assert.equal(refused.isError, true);
    assert.equal(uploads.length, 2);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
