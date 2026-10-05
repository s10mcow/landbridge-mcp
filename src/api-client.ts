import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    const { message, code } = readErrorBody(body, status);
    super(`API ${method} ${path} failed (${status}${code ? ` ${code}` : ""}): ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type RequestOptions = {
  organizationId?: string;
};

export type ApiClient = {
  get(path: string, options?: RequestOptions): Promise<unknown>;
  post(path: string, body?: unknown, options?: RequestOptions): Promise<unknown>;
  patch(path: string, body?: unknown, options?: RequestOptions): Promise<unknown>;
  delete(path: string, options?: RequestOptions): Promise<unknown>;
  upload(
    path: string,
    filePath: string,
    fields?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<unknown>;
};

export type ApiClientConfig = {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiUrl = config.apiUrl.replace(/\/$/, "");

  async function request(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<unknown> {
    const organizationId = cleanOrganizationId(options?.organizationId);
    const headers: Record<string, string> = {
      "X-API-Key": config.apiKey,
    };

    let nextPath = path;
    let nextBody = body;
    if (organizationId) {
      headers["X-Organization-Id"] = organizationId;
      if (method === "GET" || method === "DELETE") {
        nextPath = appendQuery(path, "organizationId", organizationId);
      }
      if (method === "POST" || method === "PATCH") {
        nextBody = isPlainObject(body) ? { ...body, organizationId } : { organizationId };
      }
    }

    if (nextBody !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetchImpl(`${apiUrl}${nextPath}`, {
      method,
      headers,
      body: nextBody !== undefined ? JSON.stringify(nextBody) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({ message: res.statusText }));
      throw new ApiError(method, nextPath, res.status, errorBody);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async function upload(
    path: string,
    filePath: string,
    fields?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<unknown> {
    const organizationId = cleanOrganizationId(options?.organizationId);
    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);
    const formData = new FormData();
    const mimeTypes: Record<string, string> = {
      ".csv": "text/csv",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const type = mimeTypes[extname(fileName).toLowerCase()] ?? "application/octet-stream";
    formData.append("file", new Blob([fileBuffer], { type }), fileName);
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, value);
      }
    }
    if (organizationId && !fields?.organizationId) {
      formData.append("organizationId", organizationId);
    }

    const headers: Record<string, string> = { "X-API-Key": config.apiKey };
    if (organizationId) headers["X-Organization-Id"] = organizationId;

    const res = await fetchImpl(`${apiUrl}${path}`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({ message: res.statusText }));
      throw new ApiError("POST", path, res.status, errorBody);
    }

    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
    upload,
  };
}

export function createApiClientFromEnv(): ApiClient {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    console.error("MCP_API_KEY is required");
    process.exit(1);
  }
  return createApiClient({
    apiUrl: process.env.MCP_API_URL || "https://api.landbridge.com",
    apiKey,
  });
}

export function appendQuery(path: string, key: string, value: string): string {
  const qIndex = path.indexOf("?");
  const pathname = qIndex === -1 ? path : path.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? "" : path.slice(qIndex + 1));
  if (!params.has(key)) params.set(key, value);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function cleanOrganizationId(organizationId?: string): string | undefined {
  const trimmed = organizationId?.trim();
  return trimmed ? trimmed : undefined;
}

function readErrorBody(body: unknown, status: number): { message: string; code?: string } {
  if (isPlainObject(body)) {
    const nested = isPlainObject(body.error) ? body.error : undefined;
    const message =
      readString(body.message) ||
      (nested ? readString(nested.message) : undefined) ||
      readString(body.error) ||
      `HTTP ${status}`;
    const code = readString(body.code) || (nested ? readString(nested.code) : undefined);
    return { message, code };
  }
  if (typeof body === "string" && body.trim()) return { message: body };
  return { message: `HTTP ${status}` };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
