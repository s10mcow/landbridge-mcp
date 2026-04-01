import { readFileSync } from "node:fs";
import { basename } from "node:path";

const API_URL = process.env.MCP_API_URL || "https://api.landbridge.com";
const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) {
  console.error("MCP_API_KEY is required");
  process.exit(1);
}

async function request(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY!,
  };

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `API ${method} ${path} failed (${res.status}): ${(error as any).message || res.statusText}`,
    );
  }

  if (res.status === 204) return null;
  return res.json();
}

async function uploadFile(
  path: string,
  filePath: string,
  fields?: Record<string, string>,
) {
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY! },
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `Upload ${path} failed (${res.status}): ${(error as any).message || res.statusText}`,
    );
  }

  return res.json();
}

export const api = {
  get: (path: string) => request("GET", path),
  post: (path: string, body?: unknown) => request("POST", path, body),
  patch: (path: string, body?: unknown) => request("PATCH", path, body),
  delete: (path: string) => request("DELETE", path),
  upload: uploadFile,
};
