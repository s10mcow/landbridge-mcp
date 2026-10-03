import { ApiError, type ApiClient, cleanOrganizationId } from "./api-client.js";

export type Organization = {
  organizationId: string;
  name: string;
  role?: string;
};

export type OrgMode =
  | { kind: "cross"; organizations: Organization[] }
  | { kind: "single"; reason: string; homeOrganization?: Organization };

export type LeadSearchParams = {
  query: string;
  searchBy?: "name" | "address" | "apn" | "phone" | "refId";
  organizationId?: string;
  limit?: number;
};

export type PropertySearchParams = {
  query: string;
  searchBy?: "address" | "apn" | "owner" | "refId";
  organizationId?: string;
  limit?: number;
};

export type CampaignSearchParams = {
  query?: string;
  organizationId?: string;
  limit?: number;
};

export type AcrossOrgsResult = {
  crossOrg: boolean;
  hits: Array<{ organization?: Organization; data: unknown }>;
};

export type MutateResult =
  | { ok: true; data: unknown }
  | { ok: false; error: Record<string, unknown> };

const HIT_KEYS = ["results", "matches", "leads", "properties", "campaigns", "data", "items", "images"] as const;
const NESTED_KEYS = ["campaign", "property", "lead"] as const;

const SINGLE_ORG_404 =
  "This API server does not expose /cross-org, so results are limited to the API key's home company.";
const SINGLE_ORG_403 =
  "This API key is not enabled for every company (crossOrg is off), so results are limited to its home company.";

export function createMultiOrg(api: ApiClient) {
  let modePromise: Promise<OrgMode> | null = null;

  function loadMode(): Promise<OrgMode> {
    if (!modePromise) {
      modePromise = detectMode().catch((error: unknown) => {
        modePromise = null;
        throw error;
      });
    }
    return modePromise;
  }

  async function detectMode(): Promise<OrgMode> {
    try {
      const body = await api.get("/cross-org/organizations");
      return { kind: "cross", organizations: parseOrganizations(body) };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        return {
          kind: "single",
          reason: error.status === 404 ? SINGLE_ORG_404 : SINGLE_ORG_403,
          homeOrganization: await readHomeOrganization(),
        };
      }
      throw error;
    }
  }

  async function readHomeOrganization(): Promise<Organization | undefined> {
    try {
      return parseHomeOrganization(await api.get("/organization"));
    } catch {
      return undefined;
    }
  }

  async function listOrganizations(): Promise<Record<string, unknown>> {
    const mode = await loadMode();
    if (mode.kind === "cross") {
      return { crossOrg: true, organizations: mode.organizations };
    }
    return {
      crossOrg: false,
      note: mode.reason,
      organizations: mode.homeOrganization ? [mode.homeOrganization] : [],
    };
  }

  async function searchLeads(params: LeadSearchParams): Promise<Record<string, unknown>> {
    return searchCollection({
      crossPath: "/cross-org/leads/search",
      fallbackPath: "/leads/search",
      query: {
        query: params.query,
        searchBy: params.searchBy,
        limit: params.limit,
      },
      organizationId: params.organizationId,
      emptyMessage: "No leads found.",
    });
  }

  async function searchProperties(params: PropertySearchParams): Promise<Record<string, unknown>> {
    return searchCollection({
      crossPath: "/cross-org/properties/search",
      fallbackPath: "/properties/search",
      query: {
        query: params.query,
        searchBy: params.searchBy,
        limit: params.limit,
      },
      organizationId: params.organizationId,
      emptyMessage: "No properties found.",
    });
  }

  async function listCampaigns(params: CampaignSearchParams): Promise<Record<string, unknown>> {
    const mode = await loadMode();
    const organizationId = cleanOrganizationId(params.organizationId);
    if (mode.kind === "cross") {
      try {
        const data = await api.get(buildPath("/cross-org/campaigns/search", {
          query: params.query,
          limit: params.limit,
        }), { organizationId });
        return finishSearch({
          mode,
          organizationId,
          data,
          emptyMessage: "No campaigns found.",
          crossOrg: true,
        });
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        const fallback = await fallbackCampaigns(params, organizationId);
        return {
          ...fallback,
          note: "The cross-company campaign route is missing on this server, so this list is the API key's home company only.",
        };
      }
    }

    const fallback = await fallbackCampaigns(params, organizationId);
    return { ...fallback, note: mode.reason };
  }

  async function fallbackCampaigns(
    params: CampaignSearchParams,
    organizationId?: string,
  ): Promise<Record<string, unknown>> {
    const mode = await loadMode();
    const data = await api.get("/campaigns", { organizationId });
    const { hits, meta } = extractHits(data);
    const query = params.query?.trim().toLowerCase();
    const filtered = query ? hits.filter((hit) => campaignMatches(hit, query)) : hits;
    const limited = params.limit ? filtered.slice(0, params.limit) : filtered;
    const fallback = orgFallback(mode, organizationId);
    const results = limited.map((hit) => labelRecord(hit, fallback));
    return {
      crossOrg: false,
      ...meta,
      ...(fallback ? { homeOrganization: publicOrg(fallback) } : {}),
      ...(results.length === 0 ? { message: "No campaigns found." } : {}),
      results,
    };
  }

  async function searchCollection(args: {
    crossPath: string;
    fallbackPath: string;
    query: Record<string, string | number | undefined>;
    organizationId?: string;
    emptyMessage: string;
  }): Promise<Record<string, unknown>> {
    const mode = await loadMode();
    const organizationId = cleanOrganizationId(args.organizationId);
    if (mode.kind === "cross") {
      try {
        const data = await api.get(buildPath(args.crossPath, args.query), { organizationId });
        return finishSearch({
          mode,
          organizationId,
          data,
          emptyMessage: args.emptyMessage,
          crossOrg: true,
        });
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
      }
    }

    const data = await api.get(buildPath(args.fallbackPath, args.query), { organizationId });
    const finished = finishSearch({
      mode,
      organizationId,
      data,
      emptyMessage: args.emptyMessage,
      crossOrg: false,
    });
    return {
      ...finished,
      note:
        mode.kind === "single"
          ? mode.reason
          : "The cross-company search route is missing on this server, so this search used the API key's home company only.",
    };
  }

  function finishSearch(args: {
    mode: OrgMode;
    organizationId?: string;
    data: unknown;
    emptyMessage: string;
    crossOrg: boolean;
  }): Record<string, unknown> {
    const { hits, meta } = extractHits(args.data);
    const fallback = orgFallback(args.mode, args.organizationId);
    const results = hits.map((hit) => labelRecord(hit, fallback));
    const organizations = organizationsInScope(args.mode, args.organizationId);
    return {
      ...meta,
      crossOrg: args.crossOrg,
      ...(args.crossOrg ? { organizations } : {}),
      ...(!args.crossOrg && fallback ? { homeOrganization: publicOrg(fallback) } : {}),
      ...(results.length === 0 ? { message: args.emptyMessage } : {}),
      results,
    };
  }

  async function lookupOfferCode(
    code: string,
    organizationId?: string,
  ): Promise<Record<string, unknown>> {
    const trimmed = code.trim();
    if (!trimmed) {
      return {
        error: "OFFER_CODE_REQUIRED",
        message: "Pass the mailer offer code, for example DNA-12A-506.",
      };
    }

    const mode = await loadMode();
    const orgId = cleanOrganizationId(organizationId);
    const normalizedCode = compactCode(trimmed);
    if (mode.kind === "cross") {
      try {
        const data = await api.get(`/cross-org/offer-codes/${encodeURIComponent(trimmed)}`, {
          organizationId: orgId,
        });
        const finished = finishSearch({
          mode,
          organizationId: orgId,
          data,
          emptyMessage: "No property or campaign matched that offer code.",
          crossOrg: true,
        });
        return { ...finished, code: trimmed, normalizedCode };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && !isMissingRoute(error)) {
          return {
            crossOrg: true,
            code: trimmed,
            normalizedCode,
            organizations: organizationsInScope(mode, orgId),
            results: [],
            message: "No property or campaign matched that offer code.",
          };
        }
        if (!isMissingRoute(error)) throw error;
      }
    }

    return fallbackOfferCode(trimmed, normalizedCode, orgId, mode);
  }

  async function fallbackOfferCode(
    code: string,
    normalizedCode: string,
    organizationId: string | undefined,
    mode: OrgMode,
  ): Promise<Record<string, unknown>> {
    const fallback = orgFallback(mode, organizationId);
    const queries = normalizedCode && compactCode(code) !== code ? [code, normalizedCode] : [code];
    let leads: unknown[] = [];
    let properties: unknown[] = [];
    for (const query of queries) {
      if (leads.length === 0) {
        leads = await homeSearch("/leads/search", query, organizationId, fallback);
      }
      if (properties.length === 0) {
        properties = await homeSearch("/properties/search", query, organizationId, fallback);
      }
    }
    const reason = mode.kind === "single" ? mode.reason : SINGLE_ORG_404;
    return {
      crossOrg: false,
      code,
      normalizedCode,
      note: `${reason} Exact offer-code matching is unavailable, so these are home-company lead and property searches for that code rather than property, campaign, or partial_property matches.`,
      ...(fallback ? { homeOrganization: publicOrg(fallback) } : {}),
      leads,
      properties,
      ...(leads.length === 0 && properties.length === 0
        ? { message: "No home-company leads or properties matched that code." }
        : {}),
    };
  }

  async function homeSearch(
    path: string,
    query: string,
    organizationId: string | undefined,
    fallback?: Organization,
  ): Promise<unknown[]> {
    try {
      const data = await api.get(buildPath(path, { query }), { organizationId });
      return extractHits(data).hits.map((hit) => labelRecord(hit, fallback));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return [];
      throw error;
    }
  }

  async function read(path: string, organizationId?: string): Promise<unknown> {
    const mode = await loadMode();
    const orgId = cleanOrganizationId(organizationId);
    const data = await api.get(path, { organizationId: orgId });
    return applyLabels(data, orgFallback(mode, orgId));
  }

  async function readAcrossOrganizations(
    path: string,
    organizationId?: string,
  ): Promise<AcrossOrgsResult> {
    const mode = await loadMode();
    const orgId = cleanOrganizationId(organizationId);
    if (orgId || mode.kind === "single") {
      try {
        const data = await api.get(path, { organizationId: orgId });
        if (data == null) return { crossOrg: mode.kind === "cross", hits: [] };
        const organization = orgFallback(mode, orgId);
        return {
          crossOrg: mode.kind === "cross",
          hits: [{ organization, data: applyLabels(data, organization) }],
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { crossOrg: mode.kind === "cross", hits: [] };
        }
        throw error;
      }
    }

    const results = await Promise.all(
      mode.organizations.map(async (organization) => {
        try {
          const data = await api.get(path, { organizationId: organization.organizationId });
          return { organization, data, error: null as unknown };
        } catch (error) {
          return { organization, data: null as unknown, error };
        }
      }),
    );

    const hits: AcrossOrgsResult["hits"] = [];
    const hardErrors: unknown[] = [];
    for (const result of results) {
      if (result.error) {
        if (result.error instanceof ApiError && result.error.status === 404) continue;
        hardErrors.push(result.error);
        continue;
      }
      if (result.data == null) continue;
      hits.push({
        organization: result.organization,
        data: applyLabels(result.data, result.organization),
      });
    }
    if (hits.length === 0 && hardErrors.length > 0) throw hardErrors[0];
    return { crossOrg: true, hits };
  }

  async function mutate(args: {
    method: "POST" | "PATCH" | "DELETE";
    path: string;
    organizationId?: string;
    body?: Record<string, unknown>;
  }): Promise<MutateResult> {
    const resolved = await resolveWrite(args.organizationId);
    if (!resolved.ok) return resolved;
    try {
      const data = await send(args.method, args.path, args.body, resolved.organizationId);
      return { ok: true, data };
    } catch (error) {
      const required = await organizationRequiredFromError(error);
      if (required) return required;
      throw error;
    }
  }

  async function upload(args: {
    path: string;
    filePath: string;
    fields?: Record<string, string>;
    organizationId?: string;
  }): Promise<MutateResult> {
    const resolved = await resolveWrite(args.organizationId);
    if (!resolved.ok) return resolved;
    try {
      const data = await api.upload(args.path, args.filePath, args.fields, {
        organizationId: resolved.organizationId,
      });
      return { ok: true, data };
    } catch (error) {
      const required = await organizationRequiredFromError(error);
      if (required) return required;
      throw error;
    }
  }

  async function send(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    organizationId?: string,
  ): Promise<unknown> {
    if (method === "DELETE") return api.delete(path, { organizationId });
    if (method === "POST") return api.post(path, body, { organizationId });
    return api.patch(path, body, { organizationId });
  }

  async function resolveWrite(
    organizationId?: string,
  ): Promise<{ ok: true; organizationId?: string } | { ok: false; error: Record<string, unknown> }> {
    const mode = await loadMode();
    const orgId = cleanOrganizationId(organizationId);
    if (mode.kind === "single") return { ok: true, organizationId: orgId };
    if (!orgId) {
      return { ok: false, error: organizationRequiredPayload(mode.organizations) };
    }
    return { ok: true, organizationId: orgId };
  }

  async function organizationRequiredFromError(
    error: unknown,
  ): Promise<{ ok: false; error: Record<string, unknown> } | undefined> {
    if (!isOrganizationRequired(error)) return undefined;
    const mode = await loadMode();
    const organizations =
      mode.kind === "cross"
        ? mode.organizations
        : mode.homeOrganization
          ? [mode.homeOrganization]
          : [];
    return { ok: false, error: organizationRequiredPayload(organizations) };
  }

  return {
    loadMode,
    listOrganizations,
    searchLeads,
    searchProperties,
    listCampaigns,
    lookupOfferCode,
    read,
    readAcrossOrganizations,
    mutate,
    upload,
  };
}

export type MultiOrg = ReturnType<typeof createMultiOrg>;

function organizationRequiredPayload(organizations: Organization[]): Record<string, unknown> {
  const message =
    organizations.length === 0
      ? "This key can act across companies, but no company memberships were returned, so there is nowhere to write. Do not guess a company."
      : "This API key can act in more than one company, and organizationId was not provided. Pass organizationId copied from the search hit (or from the list below). Do not guess.";
  return {
    error: "ORGANIZATION_REQUIRED",
    message,
    organizations,
  };
}

function isOrganizationRequired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) return false;
  if (error.code === "ORGANIZATION_REQUIRED") return true;
  return /ORGANIZATION_REQUIRED|organizationId is required|organization id is required/i.test(error.message);
}

function isMissingRoute(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  const blob = JSON.stringify(error.body ?? "").toLowerCase();
  return blob.includes("cannot get") || blob.includes("cannot find") || blob.includes("no route");
}

function organizationsInScope(mode: OrgMode, organizationId?: string): Organization[] {
  if (mode.kind === "single") return mode.homeOrganization ? [mode.homeOrganization] : [];
  if (!organizationId) return mode.organizations;
  const match = mode.organizations.find((org) => org.organizationId === organizationId);
  return match ? [match] : [{ organizationId, name: organizationId }];
}

function orgFallback(mode: OrgMode, organizationId?: string): Organization | undefined {
  if (organizationId) {
    if (mode.kind === "cross") {
      return (
        mode.organizations.find((org) => org.organizationId === organizationId) ?? {
          organizationId,
          name: organizationId,
        }
      );
    }
    if (mode.homeOrganization?.organizationId === organizationId) return mode.homeOrganization;
    return { organizationId, name: mode.homeOrganization?.name || organizationId };
  }
  if (mode.kind === "single") return mode.homeOrganization;
  return undefined;
}

function publicOrg(org: Organization): Organization {
  return {
    organizationId: org.organizationId,
    name: org.name,
    ...(org.role ? { role: org.role } : {}),
  };
}

function parseOrganizations(body: unknown): Organization[] {
  const list = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.organizations)
      ? body.organizations
      : null;
  if (!list) {
    throw new Error("GET /cross-org/organizations did not return { organizations: [...] }.");
  }
  return list.flatMap((entry) => {
    const org = parseOrganization(entry);
    return org ? [org] : [];
  });
}

function parseHomeOrganization(body: unknown): Organization | undefined {
  if (!isPlainObject(body)) return undefined;
  const nested = isPlainObject(body.organization) ? body.organization : body;
  return parseOrganization(nested);
}

function parseOrganization(value: unknown): Organization | undefined {
  if (!isPlainObject(value)) return undefined;
  const organizationId = readString(value.organizationId) || readString(value.id);
  const name = readString(value.name) || readString(value.organizationName) || organizationId;
  if (!organizationId || !name) return undefined;
  const role = readString(value.role);
  return { organizationId, name, ...(role ? { role } : {}) };
}

function extractHits(data: unknown): { hits: unknown[]; meta: Record<string, unknown> } {
  if (Array.isArray(data)) return { hits: data, meta: {} };
  if (!isPlainObject(data)) return { hits: [], meta: {} };
  for (const key of HIT_KEYS) {
    if (Array.isArray(data[key])) {
      const meta = { ...data };
      delete meta[key];
      return { hits: data[key] as unknown[], meta };
    }
  }
  const metaKeys = new Set(["total", "count", "limit", "offset", "page", "pageSize", "message"]);
  if (Object.keys(data).every((key) => metaKeys.has(key))) return { hits: [], meta: data };
  return { hits: [data], meta: {} };
}

function applyLabels(data: unknown, fallback?: Organization): unknown {
  if (!fallback) return data;
  if (Array.isArray(data)) return data.map((item) => labelRecord(item, fallback));
  if (!isPlainObject(data)) return data;
  const labeled = labelRecord(data, fallback);
  if (!isPlainObject(labeled)) return labeled;
  for (const key of HIT_KEYS) {
    if (Array.isArray(labeled[key])) {
      labeled[key] = (labeled[key] as unknown[]).map((item) => labelRecord(item, fallback));
    }
  }
  return labeled;
}

function labelRecord(record: unknown, fallback?: Organization, depth = 0): unknown {
  if (!isPlainObject(record)) return record;
  const ownId = readString(record.organizationId);
  const ownName = readString(record.organizationName) || readString(record.organization_name);
  const fallbackIdOk = !ownId || !fallback || fallback.organizationId === ownId;
  const fallbackNameOk = !ownName || !fallback || fallback.name === ownName;
  const organizationId = ownId || (fallbackNameOk ? fallback?.organizationId : undefined);
  const organizationName = ownName || (fallbackIdOk ? fallback?.name : undefined);
  const next: Record<string, unknown> = { ...record };
  if (organizationId) next.organizationId = organizationId;
  if (organizationName) next.organizationName = organizationName;
  if (organizationId && organizationName && !readString(next.organizationLabel)) {
    next.organizationLabel = `${organizationName} (${organizationId})`;
  }
  if (depth >= 2) return next;
  const nestedFallback: Organization | undefined =
    organizationId && organizationName ? { organizationId, name: organizationName } : fallback;
  for (const key of NESTED_KEYS) {
    if (isPlainObject(next[key])) {
      next[key] = labelRecord(next[key], nestedFallback, depth + 1);
    }
  }
  return next;
}

function campaignMatches(campaign: unknown, query: string): boolean {
  if (!isPlainObject(campaign)) return false;
  const haystack = [campaign.name, campaign.title, campaign.campaignName, campaign.refId, campaign.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function compactCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function buildPath(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
