import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a", "ascii");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x18, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

test("upload_lead_image sends png, jpeg, gif, and webp types from the extension or magic bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-image-test-"));
  const uploads: Array<{ org: string | undefined; apiKey: string | undefined; form: FormData }> = [];
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
    if (!req.url?.startsWith("/leads/") || req.method !== "POST") {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": req.headers["content-type"]! },
    }).formData();
    uploads.push({
      org: req.headers["x-organization-id"] as string | undefined,
      apiKey: req.headers["x-api-key"] as string | undefined,
      form,
    });
    res.end(JSON.stringify({ imageId: "img_1", organizationId: "org-target" }));
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
  const client = new Client({ name: "image-upload-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const cases: Array<[string, Buffer, string]> = [
      ["riley-lee-landid.png", PNG, "image/png"],
      ["riley-lee-landid.bin", PNG, "image/png"],
      ["photo.bin", JPEG, "image/jpeg"],
      ["shot.PNG", JPEG, "image/jpeg"],
      ["parcel", GIF, "image/gif"],
      ["map.txt", WEBP, "image/webp"],
      ["diagram.jpg", Buffer.from("not-really-a-jpeg"), "image/jpeg"],
    ];
    for (const [name, bytes, mime] of cases) {
      const filePath = join(dir, name);
      writeFileSync(filePath, bytes);
      const result = await client.callTool({
        name: "upload_lead_image",
        arguments: {
          leadId: "lead_1",
          filePath,
          description: "land id",
          organizationId: "org-target",
        },
      });
      assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
      const upload = uploads.at(-1)!;
      assert.equal(upload.org, "org-target");
      assert.equal(upload.apiKey, "test-only");
      assert.equal(upload.form.get("organizationId"), "org-target");
      assert.equal(upload.form.get("description"), "land id");
      const file = upload.form.get("file") as File;
      assert.equal(file.name, name);
      assert.equal(file.type, mime, `${name} was ${file.type}`);
      assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), bytes), 0);
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
