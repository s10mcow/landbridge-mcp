import { z } from "zod";

/** Free-text fields such as zoning, owner, and road notes. */
export const MAX_DD_SHORT_TEXT = 2_000;
/** Legal description, covenants, rationale, and other long notes. */
export const MAX_DD_LONG_TEXT = 20_000;
export const MAX_DD_URL = 2_000;
export const MAX_DD_ITEMS = 50;
/** Whole JSON body, matching the property-enrichment markdown cap. */
export const MAX_DUE_DILIGENCE_JSON_CHARS = 100_000;

export const DD_STATUS = ["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "PASS"] as const;
export const ITEM_STATUS = ["OPEN", "VERIFIED", "NA"] as const;
export const ITEM_KIND = ["risk", "open_item"] as const;
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

function shortText() {
  return z.string().trim().min(1).max(MAX_DD_SHORT_TEXT);
}

function longText() {
  return z.string().trim().min(1).max(MAX_DD_LONG_TEXT);
}

function money() {
  return z.number().finite().nonnegative();
}

const itemSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Existing item id. Omit to let the API assign one."),
    text: longText().describe("The risk, or what still needs to be checked."),
    status: z.enum(ITEM_STATUS).describe("OPEN, VERIFIED, or NA (n/a)."),
    sourceUrl: z
      .string()
      .trim()
      .min(1)
      .max(MAX_DD_URL)
      .optional()
      .describe("Page or document that supports this item."),
  })
  .strict();

export const dueDiligenceSections = {
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
    .describe("Legal description, plat, acreage, dimensions, and subdivision. APN is the separate apn argument."),
  title: z
    .object({
      ownerOfRecord: shortText().optional(),
      deedBook: shortText().optional(),
      deedPage: shortText().optional(),
      deedDate: shortText().optional().describe("Deed date as printed, such as 1998-03-02."),
      deedPrice: money().optional(),
      sellerRelation: z
        .enum(SELLER_RELATION)
        .optional()
        .describe("How the seller relates to the owner of record: OWNER, SPOUSE, HEIR, ENTITY, or OTHER."),
      authorityNotes: longText().optional().describe("Authority or probate notes."),
    })
    .strict()
    .optional(),
  values: z
    .object({
      landValue: money().optional(),
      assessedValue: money().optional(),
      taxAmount: money().optional(),
      taxYear: z.number().int().min(1800).max(2200).optional(),
      trusteeStatus: z.enum(TRUSTEE_STATUS).optional().describe("PAID or DELINQUENT."),
    })
    .strict()
    .optional()
    .describe("Land value, assessed value, tax, and trustee status."),
  access: z
    .object({
      roadType: z.enum(ROAD_TYPE).optional().describe("PAVED, GRAVEL, DIRT, or NONE."),
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
      dues: money().optional().describe("HOA or POA dues amount."),
      covenants: longText().optional(),
      strAllowed: z.boolean().optional().describe("Short-term rentals allowed."),
      mobileHomesAllowed: z.boolean().optional(),
      minimumSqFt: z.number().finite().nonnegative().optional(),
    })
    .strict()
    .optional(),
  valuation: z
    .object({
      marketValueLow: money().optional(),
      marketValueHigh: money().optional(),
      offerLow: money().optional(),
      offerHigh: money().optional(),
      offerTarget: money().optional(),
      rationale: longText().optional(),
    })
    .strict()
    .optional(),
  risks: z
    .array(itemSchema)
    .max(MAX_DD_ITEMS)
    .optional()
    .describe(
      `Replaces the full risks list for this parcel (max ${MAX_DD_ITEMS}). Use update_dd_item to change one item.`,
    ),
  openItems: z
    .array(itemSchema)
    .max(MAX_DD_ITEMS)
    .optional()
    .describe(
      `Replaces the full open-items list for this parcel (max ${MAX_DD_ITEMS}). Use update_dd_item to check one off.`,
    ),
};

const IDENTITY_KEYS = new Set(["apn", "propertyId"]);

export function resolveDueDiligenceTarget(args: {
  leadId?: string;
  propertyId?: string;
  apn?: string;
  requireParcel: boolean;
}): TargetResult {
  const leadId = args.leadId?.trim();
  const propertyId = args.propertyId?.trim();
  const apn = args.apn?.trim();
  if (!leadId && !propertyId) {
    return {
      ok: false,
      error: {
        error: "TARGET_REQUIRED",
        message: "Pass leadId, propertyId, or both. A parcel with no lead uses propertyId.",
      },
    };
  }
  if (leadId && args.requireParcel && !propertyId && !apn) {
    return {
      ok: false,
      error: {
        error: "PARCEL_REQUIRED",
        message:
          "This lead can have more than one parcel. Pass apn or propertyId for the parcel this due diligence belongs to.",
      },
    };
  }

  const identity: Record<string, string> = {};
  if (apn) identity.apn = apn;
  if (leadId && propertyId) identity.propertyId = propertyId;
  const path = leadId
    ? `/leads/${encodeURIComponent(leadId)}/due-diligence`
    : `/properties/${encodeURIComponent(propertyId!)}/due-diligence`;
  return { ok: true, path, identity };
}

export function dueDiligenceReadPath(args: {
  leadId?: string;
  propertyId?: string;
  apn?: string;
}): { ok: true; path: string } | { ok: false; error: ToolError } {
  const target = resolveDueDiligenceTarget({ ...args, requireParcel: false });
  if (!target.ok) return target;
  const params = new URLSearchParams();
  const propertyId = args.propertyId?.trim();
  const apn = args.apn?.trim();
  if (args.leadId?.trim() && propertyId) params.set("propertyId", propertyId);
  if (apn) params.set("apn", apn);
  const qs = params.toString();
  return { ok: true, path: qs ? `${target.path}?${qs}` : target.path };
}

export function valueRangeError(valueMin?: number, valueMax?: number): ToolError | undefined {
  if (valueMin !== undefined && valueMax !== undefined && valueMin > valueMax) {
    return {
      error: "VALUE_RANGE_INVALID",
      message: "valueMin cannot be greater than valueMax.",
    };
  }
  return undefined;
}

type SectionInput = {
  status?: (typeof DD_STATUS)[number];
  parcel?: object;
  title?: object;
  values?: object;
  access?: object;
  buildability?: object;
  restrictions?: object;
  valuation?: object;
  risks?: unknown[];
  openItems?: unknown[];
};

export function buildDueDiligenceBody(
  identity: Record<string, string>,
  fields: SectionInput,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const body: Record<string, unknown> = { ...identity };
  if (fields.status) body.status = fields.status;
  for (const key of ["parcel", "title", "values", "access", "buildability", "restrictions", "valuation"] as const) {
    const value = compactSection(fields[key]);
    if (value) body[key] = value;
  }
  if (fields.risks) body.risks = fields.risks;
  if (fields.openItems) body.openItems = fields.openItems;
  if (!Object.keys(body).some((key) => !IDENTITY_KEYS.has(key))) {
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
    price?: number;
    date?: string;
    status?: (typeof COMP_STATUS)[number];
    url?: string;
  },
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const body: Record<string, unknown> = {
    ...identity,
    address: comp.address,
  };
  if (comp.acres !== undefined) body.acres = comp.acres;
  if (comp.price !== undefined) body.price = comp.price;
  if (comp.date) body.date = comp.date;
  if (comp.status) body.status = comp.status;
  if (comp.url) body.url = comp.url;
  const tooLarge = payloadTooLarge(body);
  if (tooLarge) return { ok: false, error: tooLarge };
  return { ok: true, body };
}

export function buildItemBody(
  identity: Record<string, string>,
  item: {
    kind?: (typeof ITEM_KIND)[number];
    status: (typeof ITEM_STATUS)[number];
    text?: string;
    sourceUrl?: string;
  },
): { ok: true; body: Record<string, unknown> } | { ok: false; error: ToolError } {
  const body: Record<string, unknown> = { ...identity, status: item.status };
  if (item.kind) body.kind = item.kind;
  if (item.text) body.text = item.text;
  if (item.sourceUrl) body.sourceUrl = item.sourceUrl;
  const tooLarge = payloadTooLarge(body);
  if (tooLarge) return { ok: false, error: tooLarge };
  return { ok: true, body };
}

function compactSection(value: object | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function payloadTooLarge(body: Record<string, unknown>): ToolError | undefined {
  const size = JSON.stringify(body).length;
  if (size <= MAX_DUE_DILIGENCE_JSON_CHARS) return undefined;
  return {
    error: "DUE_DILIGENCE_TOO_LARGE",
    message: `Due diligence payload is ${size} characters, and the limit is ${MAX_DUE_DILIGENCE_JSON_CHARS}.`,
  };
}
