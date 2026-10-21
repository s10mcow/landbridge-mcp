const PRICE_FIELDS = ["offerPrice", "purchasePrice", "sellingPrice"] as const;

export type PriceField = (typeof PRICE_FIELDS)[number];

export type AddPropertyInput = {
  refId?: string;
  apn?: string;
  county?: string;
  state?: string;
  offerPrice?: number;
  purchasePrice?: number;
  sellingPrice?: number;
};

export type ToolError = { error: string; message: string };

const PROPERTIES_NOTE =
  "This API has no GET /leads/{leadId}/properties route, so properties only includes parcels embedded on the lead. Additional parcels are omitted until that route, or a properties array on the lead, is deployed.";

export function buildAddPropertyBody(
  input: AddPropertyInput,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const refId = clean(input.refId);
  const apn = clean(input.apn);
  const county = clean(input.county);
  const state = clean(input.state);
  if (!refId && !apn) {
    return {
      ok: false,
      error: {
        error: "PROPERTY_IDENTIFIER_REQUIRED",
        message: "Pass refId, or apn with county and state.",
      },
    };
  }
  if (!refId && (!county || !state)) {
    return {
      ok: false,
      error: {
        error: "COUNTY_AND_STATE_REQUIRED",
        message: "Finding or creating a parcel by APN needs county and state.",
      },
    };
  }

  const body: Record<string, unknown> = {};
  if (refId) body.refId = refId;
  if (apn) body.apn = apn;
  if (county) body.county = county;
  if (state) body.state = state;
  for (const field of PRICE_FIELDS) {
    const value = input[field];
    if (value !== undefined) body[field] = value;
  }
  return { ok: true, body };
}

export function applyLeadProperties(
  lead: Record<string, unknown>,
  listed: unknown[] | undefined,
  options: { listUnavailable: boolean },
): Record<string, unknown> {
  const embeddedList = Array.isArray(lead.properties) ? lead.properties : undefined;
  const source = embeddedList ?? listed;
  const properties = dedupeProperties([
    ...objectsFrom(source),
    ...(isPlainObject(lead.property) ? [lead.property] : []),
  ]);
  const next: Record<string, unknown> = { ...lead, properties };
  if (options.listUnavailable && embeddedList === undefined) {
    next.propertiesNote = PROPERTIES_NOTE;
  } else {
    delete next.propertiesNote;
  }
  if (!isPlainObject(next.pricing)) {
    const pricing = pricingTotals(properties);
    if (pricing) next.pricing = pricing;
  }
  return next;
}

export function groupOwnerHits(
  hits: unknown[],
  kind: "lead" | "property",
): Array<Record<string, unknown>> {
  const groups = new Map<
    string,
    {
      ownerName?: string;
      organizationId?: string;
      organizationName?: string;
      organizationLabel?: string;
      leadIds: string[];
      leads: Record<string, unknown>[];
      properties: Record<string, unknown>[];
    }
  >();

  hits.forEach((hit, index) => {
    if (!isPlainObject(hit)) return;
    const ownerName = ownerNameOf(hit, kind);
    const organizationId = readString(hit.organizationId);
    const normalized = normalizeOwner(ownerName);
    const key = normalized
      ? `${organizationId ?? ""}\0${normalized}`
      : `\0${index}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        ...(ownerName ? { ownerName } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(readString(hit.organizationName) ? { organizationName: readString(hit.organizationName) } : {}),
        ...(readString(hit.organizationLabel) ? { organizationLabel: readString(hit.organizationLabel) } : {}),
        leadIds: [],
        leads: [],
        properties: [],
      };
      groups.set(key, group);
    }
    if (kind === "lead") group.leads.push(hit);
    const leadId = readString(hit.leadId) || (kind === "lead" ? readString(hit.id) : undefined);
    if (leadId && !group.leadIds.includes(leadId)) group.leadIds.push(leadId);
    group.properties = dedupeProperties([...group.properties, ...parcelsOf(hit, kind)]);
  });

  return [...groups.values()].map((group) => {
    const pricing = pricingTotals(group.properties);
    return {
      ...(group.ownerName ? { ownerName: group.ownerName } : {}),
      ...(group.organizationId ? { organizationId: group.organizationId } : {}),
      ...(group.organizationName ? { organizationName: group.organizationName } : {}),
      ...(group.organizationLabel ? { organizationLabel: group.organizationLabel } : {}),
      leadIds: group.leadIds,
      ...(kind === "lead" ? { leads: group.leads } : {}),
      properties: group.properties,
      ...(pricing ? { pricing } : {}),
    };
  });
}

export function pricingTotals(
  properties: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const totals: Record<string, unknown> = { propertyCount: properties.length };
  let any = false;
  for (const field of PRICE_FIELDS) {
    const values = properties
      .map((property) => property[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) continue;
    any = true;
    totals[field] = roundMoney(values.reduce((sum, value) => sum + value, 0));
    if (values.length !== properties.length) totals[`${field}Count`] = values.length;
  }
  return any ? totals : undefined;
}

function parcelsOf(hit: Record<string, unknown>, kind: "lead" | "property"): Array<Record<string, unknown>> {
  const nested = dedupeProperties([
    ...(isPlainObject(hit.property) ? [hit.property] : []),
    ...objectsFrom(Array.isArray(hit.properties) ? hit.properties : undefined),
  ]);
  if (nested.length > 0) return nested;
  if (kind === "property") return [hit];
  return [];
}

function dedupeProperties(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const unique: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const key = propertyKey(item);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(item);
  }
  return unique;
}

function propertyKey(property: Record<string, unknown>): string | undefined {
  const id = readString(property.id) || readString(property.propertyId);
  if (id) return `id:${id}`;
  const refId = readString(property.refId);
  if (refId) return `ref:${refId.toLowerCase()}`;
  const apn = readString(property.apn);
  if (!apn) return undefined;
  const county = readString(property.county) ?? "";
  const state = readString(property.state) ?? "";
  return `apn:${apn}|${county}|${state}`.toLowerCase();
}

function ownerNameOf(hit: Record<string, unknown>, kind: "lead" | "property"): string | undefined {
  const direct = readString(hit.ownerName) || readString(hit.owner);
  if (direct) return direct;
  if (isPlainObject(hit.property)) {
    const nested = readString(hit.property.ownerName) || readString(hit.property.owner);
    if (nested) return nested;
  }
  if (kind === "lead") return readString(hit.name);
  return undefined;
}

function normalizeOwner(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}

function objectsFrom(value: unknown[] | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  return value.filter(isPlainObject);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
