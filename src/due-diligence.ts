import { z } from "zod";
import { ApiError } from "./api-client.js";

/** Free-text fields such as zoning, owner, and road notes. */
export const MAX_DD_SHORT_TEXT = 2_000;
/** Legal description, covenants, rationale, and other long notes. */
export const MAX_DD_LONG_TEXT = 20_000;
export const MAX_DD_URL = 2_000;
/** Whole JSON body, matching the property-enrichment markdown cap. */
export const MAX_DUE_DILIGENCE_JSON_CHARS = 100_000;

export const DD_STATUS = ["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "PASS"] as const;
export const ITEM_STATUS = ["OPEN", "VERIFIED", "NA"] as const;
export const ITEM_KIND = ["RISK", "OPEN_ITEM"] as const;
export const COMP_STATUS = ["SOLD", "ACTIVE"] as const;
export const ROAD_TYPE = ["PAVED", "GRAVEL", "DIRT", "NONE"] as const;
export const ROAD_MAINTENANCE = ["COUNTY", "PRIVATE"] as const;
export const TRUSTEE_STATUS = ["PAID", "DELINQUENT"] as const;
export const SELLER_RELATION = ["OWNER", "SPOUSE", "HEIR", "ENTITY", "OTHER"] as const;

export type DueDiligenceStatus = (typeof DD_STATUS)[number];

export type ToolError = Record<string, unknown>;

export type TargetResult =
  | { ok: true; path: string; identity: Record<string, string> }
  | { ok: false; error: ToolError };

const MONEY_FIELDS: Record<string, readonly string[]> = {
  title: ["deedPrice"],
  values: ["landValue", "assessedValue", "taxAmount"],
  restrictions: ["dues"],
  valuation: ["marketValueLow", "marketValueHigh", "offerLow", "offerHigh", "offerTarget"],
};

function shortText() {
  return z.string().trim().min(1).max(MAX_DD_SHORT_TEXT);
}

function longText() {
  return z.string().trim().min(1).max(MAX_DD_LONG_TEXT);
}

/** Currency on the wire is a 2-decimal string. Callers may pass a number or "15000.5". */
function amount() {
  return z.union([
    z.number().finite().nonnegative(),
    z.string().trim().regex(/^(?:\d+|\d+\.\d{1,2})$/),
  ]);
}

export function dateInput() {
  return z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isIsoDate, "Date must be a real YYYY-MM-DD date.");
}

function isoDate() {
  return dateInput();
}

export function formatAmount(value: unknown): string {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Amount must be a non-negative number with at most two decimal places.");
  }
  return numeric.toFixed(2);
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const dueDiligenceSections = {
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Revision from the last get_due_diligence read. A stale revision comes back as 409 DD_CONFLICT; read again and retry.",
    ),
  status: z
    .enum(DD_STATUS)
    .optional()
    .describe("Overall status for this parcel: NOT_STARTED, IN_PROGRESS, COMPLETE, or PASS."),
  parcel: z
    .object({
      legalDescription: longText().optional(),
      platBook: shortText().optional(),
      platPage: shortText().optional(),
      acreage: z.number().finite().nonnegative().optional(),
      dimensions: shortText().optional().describe("Parcel dimensions, such as 200 x 400."),
      subdivision: shortText().optional(),
    })
    .strict()
    .optional()
    .describe("Legal description, plat, acreage, dimensions, and subdivision. The APN is parcelApn."),
  title: z
    .object({
      ownerOfRecord: shortText().optional(),
      deedBook: shortText().optional(),
      deedPage: shortText().optional(),
      deedDate: isoDate().optional().describe("Deed date as YYYY-MM-DD."),
      deedPrice: amount().optional().describe("Deed price. Sent as a 2-decimal string."),
      seller: z
        .enum(SELLER_RELATION)
        .optional()
        .describe("How the seller relates to the owner of record: OWNER, SPOUSE, HEIR, ENTITY, or OTHER."),
      authorityNotes: longText().optional().describe("Authority or probate notes."),
    })
    .strict()
    .optional(),
  values: z
    .object({
      landValue: amount().optional().describe("Sent as a 2-decimal string."),
      assessedValue: amount().optional().describe("Sent as a 2-decimal string."),
      taxAmount: amount().optional().describe("Sent as a 2-decimal string."),
      taxYear: z.number().int().min(1800).max(2200).optional(),
      trustee: z.enum(TRUSTEE_STATUS).optional().describe("PAID or DELINQUENT."),
    })
    .strict()
    .optional()
    .describe("Land value, assessed value, tax, and trustee status."),
  access: z
    .object({
      road: z.enum(ROAD_TYPE).optional().describe("PAVED, GRAVEL, DIRT, or NONE."),
      maintenance: z.enum(ROAD_MAINTENANCE).optional().describe("COUNTY or PRIVATE."),
      notes: longText().optional(),
    })
    .strict()
    .optional(),
  buildability: z
    .object({
      slope: shortText().optional(),
      zoning: shortText().optional(),
      floodZone: shortText().optional(),
      septicStatus: shortText().optional().describe("Septic or perc status."),
      waterSewer: shortText().optional().describe("Water and sewer availability."),
    })
    .strict()
    .optional(),
  restrictions: z
    .object({
      hoa: z.boolean().optional().describe("True when an HOA or POA applies."),
      hoaName: shortText().optional(),
      dues: amount().optional().describe("HOA or POA dues. Sent as a 2-decimal string."),
      covenants: longText().optional(),
      strAllowed: z.boolean().optional().describe("Short-term rentals allowed."),
      mobileHomesAllowed: z.boolean().optional(),
      minimumSqFt: z.number().finite().nonnegative().optional(),
    })
    .strict()
    .optional(),
  valuation: z
    .object({
      marketValueLow: amount().optional().describe("Sent as a 2-decimal string."),
      marketValueHigh: amount().optional().describe("Sent as a 2-decimal string."),
      offerLow: amount().optional().describe("Sent as a 2-decimal string."),
      offerHigh: amount().optional().describe("Sent as a 2-decimal string."),
      offerTarget: amount().optional().describe("Sent as a 2-decimal string."),
      rationale: longText().optional(),
    })
    .strict()
    .optional(),
};

const NON_CONTENT_KEYS = new Set(["parcelApn", "propertyId", "expectedRevision"]);

export function resolveDueDiligenceTarget(args: {
  leadId?: string;
  propertyId?: string;
  parcelApn?: string;
}): TargetResult {
  const leadId = args.leadId?.trim();
  const propertyId = args.propertyId?.trim();
  const parcelApn = args.parcelApn?.trim();
  if (!leadId && !propertyId) {
    return {
      ok: false,
      error: {
        error: "TARGET_REQUIRED",
        message: "Pass leadId, propertyId, or both. A parcel with no lead uses propertyId.",
      },
    };
  }

  // The lead PATCH selects the parcel. Both selectors are optional when the lead has one parcel.
  const identity: Record<string, string> = {};
  if (leadId && parcelApn) identity.parcelApn = parcelApn;
  if (leadId && propertyId) identity.propertyId = propertyId;
  const path = leadId
    ? `/leads/${encodeURIComponent(leadId)}/due-diligence`
    : `/properties/${encodeURIComponent(propertyId!)}/due-diligence`;
  return { ok: true, path, identity };
}

export function dueDiligenceReadPath(args: {
  leadId?: string;
  propertyId?: string;
  parcelApn?: string;
}): { ok: true; path: string } | { ok: false; error: ToolError } {
  const target = resolveDueDiligenceTarget(args);
  if (!target.ok) return target;
  const params = new URLSearchParams();
  const propertyId = args.propertyId?.trim();
  const parcelApn = args.parcelApn?.trim();
  if (args.leadId?.trim() && propertyId) params.set("propertyId", propertyId);
  if (args.leadId?.trim() && parcelApn) params.set("parcelApn", parcelApn);
  const qs = params.toString();
  return { ok: true, path: qs ? `${target.path}?${qs}` : target.path };
}

type SectionInput = {
  expectedRevision?: number;
  status?: (typeof DD_STATUS)[number];
  parcel?: object;
  title?: object;
  values?: object;
  access?: object;
  buildability?: object;
  restrictions?: object;
  valuation?: object;
};

export function buildDueDiligenceBody(
  identity: Record<string, string>,
  fields: SectionInput,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const body: Record<string, unknown> = { ...identity };
  if (fields.expectedRevision !== undefined) body.expectedRevision = fields.expectedRevision;
  if (fields.status) body.status = fields.status;
  for (const key of ["parcel", "title", "values", "access", "buildability", "restrictions", "valuation"] as const) {
    const value = compactSection(fields[key], MONEY_FIELDS[key]);
    if (!value.ok) return value;
    if (value.section) body[key] = value.section;
  }
  if (!Object.keys(body).some((key) => !NON_CONTENT_KEYS.has(key))) {
    return {
      ok: false,
      error: {
        error: "DUE_DILIGENCE_FIELDS_REQUIRED",
        message: "Pass at least one due diligence field to update. Omitted fields are left unchanged.",
      },
    };
  }
  const tooLarge = payloadTooLarge(body);
  if (tooLarge) return { ok: false, error: tooLarge };
  return { ok: true, body };
}

export function buildCompBody(
  identity: Record<string, string>,
  comp: {
    address: string;
    acres?: number;
    price?: number | string;
    date?: string;
    status?: (typeof COMP_STATUS)[number];
    url?: string;
  },
  expectedRevision?: number,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const entry: Record<string, unknown> = { address: comp.address };
  if (comp.acres !== undefined) entry.acres = comp.acres;
  if (comp.price !== undefined) entry.price = formatAmount(comp.price);
  if (comp.date) entry.date = comp.date;
  if (comp.status) entry.status = comp.status;
  if (comp.url) entry.url = comp.url;
  const body: Record<string, unknown> = { ...identity, comps: { add: [entry] } };
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
  const tooLarge = payloadTooLarge(body);
  if (tooLarge) return { ok: false, error: tooLarge };
  return { ok: true, body };
}

export function buildItemBody(
  identity: Record<string, string>,
  item: {
    itemId: string;
    kind?: (typeof ITEM_KIND)[number];
    status: (typeof ITEM_STATUS)[number];
    text?: string;
    sourceUrl?: string;
  },
  expectedRevision?: number,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const entry: Record<string, unknown> = { itemId: item.itemId, status: item.status };
  if (item.kind) entry.kind = item.kind;
  if (item.text) entry.text = item.text;
  if (item.sourceUrl) entry.sourceUrl = item.sourceUrl;
  const body: Record<string, unknown> = { ...identity, items: { update: [entry] } };
  if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
  const tooLarge = payloadTooLarge(body);
  if (tooLarge) return { ok: false, error: tooLarge };
  return { ok: true, body };
}

export function dueDiligenceConflict(error: unknown): ToolError | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status !== 409 && error.code !== "DD_CONFLICT") return undefined;
  const apiMessage = readApiMessage(error.body);
  const message = apiMessage
    ? `Due diligence conflict: ${apiMessage} Read the record again with get_due_diligence and retry with its current revision as expectedRevision.`
    : "Due diligence changed since expectedRevision. Read the record again with get_due_diligence and retry with its current revision as expectedRevision.";
  return {
    error: "DD_CONFLICT",
    message,
    status: error.status,
    details: error.body,
  };
}

function compactSection(
  value: object | undefined,
  moneyKeys: readonly string[] | undefined,
): { ok: true; section?: Record<string, unknown> } | { ok: false; error: ToolError } {
  if (!value) return { ok: true };
  const money = new Set(moneyKeys ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (money.has(key)) {
      try {
        out[key] = formatAmount(entry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: { error: "AMOUNT_INVALID", message: `${key}: ${reason}` },
        };
      }
      continue;
    }
    out[key] = entry;
  }
  return { ok: true, section: Object.keys(out).length > 0 ? out : undefined };
}

function payloadTooLarge(body: Record<string, unknown>): ToolError | undefined {
  const size = JSON.stringify(body).length;
  if (size <= MAX_DUE_DILIGENCE_JSON_CHARS) return undefined;
  return {
    error: "DUE_DILIGENCE_TOO_LARGE",
    message: `Due diligence payload is ${size} characters, and the limit is ${MAX_DUE_DILIGENCE_JSON_CHARS}.`,
  };
}

function readApiMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}
