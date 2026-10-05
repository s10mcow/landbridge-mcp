import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiClient } from "./api-client.js";
import { createMultiOrg } from "./multi-org.js";

const ORGS = {
  crossOrg: true,
  organizations: [
    { organizationId: "org_north", name: "North Acre Co", role: "owner" },
    { organizationId: "org_south", name: "South Acre Co", role: "admin" },
  ],
};

type RouteResult = { status?: number; body?: unknown };

type Seen = {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  form?: Record<string, string>;
};

function client(
  handler: (seen: Seen) => RouteResult,
): { lb: ReturnType<typeof createMultiOrg>; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: unknown;
    let form: Record<string, string> | undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    if (init?.body instanceof FormData) {
      form = {};
      for (const [key, value] of init.body.entries()) {
        form[key] = typeof value === "string" ? value : value.name;
      }
    }
    const seen: Seen = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      body,
      form,
    };
    calls.push(seen);
    const result = handler(seen);
    const status = result.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(result.body ?? null), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const api = createApiClient({
    apiUrl: "https://api.test",
    apiKey: "lbapi_sk_test",
    fetchImpl,
  });
  return { lb: createMultiOrg(api), calls };
}

function orgHeader(seen: Seen): string | null {
  return seen.headers.get("x-organization-id");
}

test("list_organizations returns every membership", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    return { status: 500, body: { message: "unexpected" } };
  });
  const listed = await lb.listOrganizations();
  assert.equal(listed.crossOrg, true);
  assert.deepEqual(listed.organizations, ORGS.organizations);
  assert.equal(calls.length, 1);
});

test("search_leads covers every company and labels hits", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/cross-org/leads/search")) {
      return {
        body: {
          leads: [
            { id: "lead_1", name: "Ada Lovelace", organizationId: "org_south", organizationName: "South Acre Co" },
          ],
        },
      };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const result = await lb.searchLeads({ query: "Ada", searchBy: "name" });
  assert.equal(result.crossOrg, true);
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results[0].organizationLabel, "South Acre Co (org_south)");
  assert.equal(orgHeader(calls[1]), null);
  assert.match(calls[1].path, /\/cross-org\/leads\/search\?/);
  assert.match(calls[1].path, /query=Ada/);
  assert.match(calls[1].path, /searchBy=name/);
  assert.equal(calls[1].path.includes("organizationId"), false);
});

test("search_properties sends an optional organization filter", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/cross-org/properties/search")) {
      return { body: [{ id: "parcel_1", apn: "12-34" }] };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const result = await lb.searchProperties({
    query: "12-34",
    searchBy: "apn",
    organizationId: "org_north",
    limit: 5,
  });
  const hit = (result.results as Array<Record<string, unknown>>)[0];
  assert.equal(hit.organizationId, "org_north");
  assert.equal(hit.organizationName, "North Acre Co");
  assert.equal(hit.organizationLabel, "North Acre Co (org_north)");
  assert.equal(orgHeader(calls[1]), "org_north");
  assert.match(calls[1].path, /organizationId=org_north/);
  assert.match(calls[1].path, /searchBy=apn/);
  assert.match(calls[1].path, /limit=5/);
});

test("lookup_offer_code hits the cross-org route and keeps matchType", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/cross-org/offer-codes/")) {
      return {
        body: {
          matches: [
            {
              matchType: "property",
              organizationId: "org_north",
              organizationName: "North Acre Co",
              property: { refId: "DNA-12A-506" },
              campaign: { id: "camp_1" },
              lead: null,
            },
          ],
        },
      };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const result = await lb.lookupOfferCode("DNA-12A-506");
  assert.equal(result.crossOrg, true);
  assert.equal(result.normalizedCode, "dna12a506");
  assert.equal(calls[1].path, "/cross-org/offer-codes/DNA-12A-506");
  const match = (result.results as Array<Record<string, unknown>>)[0];
  assert.equal(match.matchType, "property");
  const property = match.property as Record<string, unknown>;
  assert.equal(property.organizationLabel, "North Acre Co (org_north)");
});

test("a missing offer code stays cross-org and does not search the home company", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/cross-org/offer-codes/")) {
      return { status: 404, body: { code: "NOT_FOUND", message: "Offer code not found" } };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const result = await lb.lookupOfferCode("DNA-12A-506");
  assert.equal(result.crossOrg, true);
  assert.deepEqual(result.results, []);
  assert.match(String(result.message), /No property or campaign matched/);
  assert.equal(calls.some((call) => call.path.startsWith("/leads/search")), false);
});

test("a 404 backend falls back to the home company and says so", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") {
      return { status: 404, body: { message: "Cannot GET /cross-org/organizations" } };
    }
    if (seen.path === "/organization") return { body: { id: "org_home", name: "Home Co" } };
    if (seen.path.startsWith("/leads/search")) {
      return { body: [{ id: "lead_home", name: "Grace" }] };
    }
    if (seen.path.startsWith("/properties/search")) return { body: [] };
    return { status: 500, body: { message: seen.path } };
  });

  const leads = await lb.searchLeads({ query: "Grace", searchBy: "phone" });
  assert.equal(leads.crossOrg, false);
  assert.match(String(leads.note), /home company/);
  const hit = (leads.results as Array<Record<string, unknown>>)[0];
  assert.equal(hit.organizationName, "Home Co");
  assert.equal(hit.organizationId, "org_home");
  assert.equal(calls.some((call) => call.path.startsWith("/cross-org/leads")), false);
  assert.match(calls.at(-1)?.path ?? "", /\/leads\/search\?/);

  const code = await lb.lookupOfferCode("dna12a506");
  assert.equal(code.crossOrg, false);
  assert.match(String(code.note), /Exact offer-code matching is unavailable/);
  assert.equal(calls.some((call) => call.path.startsWith("/cross-org/offer-codes")), false);
});

test("a single-org key (403) falls back and writes do not require organizationId", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") {
      return { status: 403, body: { message: "Forbidden", code: "FORBIDDEN" } };
    }
    if (seen.path === "/organization") return { body: { organizationId: "org_home", name: "Home Co" } };
    if (seen.method === "POST" && seen.path === "/leads") return { body: { id: "lead_new" } };
    return { status: 500, body: { message: seen.path } };
  });

  const created = await lb.mutate({
    method: "POST",
    path: "/leads",
    body: { refId: "PB-CS-1015-2063" },
  });
  assert.equal(created.ok, true);
  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(orgHeader(post), null);
  assert.deepEqual(post.body, { refId: "PB-CS-1015-2063" });
});

test("a single-org key receiving HTTP 200 keeps implicit home-company writes", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: { crossOrg: false, organizations: [ORGS.organizations[0]] } };
    if (seen.method === "PATCH") return { body: { leadId: "lead_1" } };
    return { status: 500 };
  });
  const listed = await lb.listOrganizations();
  assert.equal(listed.crossOrg, false);
  const result = await lb.mutate({ method: "PATCH", path: "/leads/lead_1", body: { name: "Updated" } });
  assert.equal(result.ok, true);
  assert.equal(orgHeader(calls.at(-1)!), null);
  assert.deepEqual(calls.at(-1)?.body, { name: "Updated" });
});

test("a cross-org key with one membership still requires an explicit organization", async () => {
  const { lb, calls } = client(() => ({ body: { crossOrg: true, organizations: [ORGS.organizations[0]] } }));
  const result = await lb.mutate({ method: "PATCH", path: "/leads/lead_1", body: { name: "Updated" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.error, "ORGANIZATION_REQUIRED");
  assert.equal(calls.length, 1);
});

for (const crossOrg of [false, true]) {
  test(`a server without credential metadata enforces singleton writes itself (crossOrg=${crossOrg})`, async () => {
    const { lb, calls } = client((seen) => {
      if (seen.path === "/cross-org/organizations") return { body: { organizations: [ORGS.organizations[0]] } };
      return crossOrg
        ? { status: 400, body: { code: "ORGANIZATION_REQUIRED" } }
        : { body: { leadId: "lead_1" } };
    });
    const listed = await lb.listOrganizations();
    assert.equal("crossOrg" in listed, false);
    const result = await lb.mutate({ method: "PATCH", path: "/leads/lead_1", body: { name: "Updated" } });
    assert.equal(result.ok, !crossOrg);
    if (!result.ok) assert.equal(result.error.error, "ORGANIZATION_REQUIRED");
    assert.equal(calls.at(-1)?.method, "PATCH");
    assert.equal(orgHeader(calls.at(-1)!), null);
  });
}

test("cross-org writes without organizationId list companies and do not call the API", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    return { status: 500, body: { message: "should not be called" } };
  });

  const updated = await lb.mutate({
    method: "PATCH",
    path: "/leads/lead_1",
    body: { stage: "NEGOTIATING" },
  });
  assert.equal(updated.ok, false);
  if (updated.ok) return;
  assert.equal(updated.error.error, "ORGANIZATION_REQUIRED");
  assert.match(String(updated.error.message), /Do not guess/);
  assert.deepEqual(updated.error.organizations, ORGS.organizations);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("cross-org writes send the company on the header and in the body", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.method === "PATCH") return { body: { id: "lead_1", stage: "NEGOTIATING" } };
    if (seen.method === "DELETE") return { status: 204 };
    if (seen.method === "POST" && seen.path === "/leads") return { body: { id: "lead_9" } };
    return { status: 500, body: { message: seen.path } };
  });

  const updated = await lb.mutate({
    method: "PATCH",
    path: "/leads/lead_1",
    organizationId: "org_south",
    body: { stage: "NEGOTIATING" },
  });
  assert.equal(updated.ok, true);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch);
  assert.equal(orgHeader(patch), "org_south");
  assert.deepEqual(patch.body, { stage: "NEGOTIATING", organizationId: "org_south" });
  assert.equal(patch.path.includes("organizationId"), false);

  const removed = await lb.mutate({
    method: "DELETE",
    path: "/campaigns/camp_1",
    organizationId: " org_north ",
  });
  assert.equal(removed.ok, true);
  const del = calls.find((call) => call.method === "DELETE");
  assert.ok(del);
  assert.equal(orgHeader(del), "org_north");
  assert.match(del.path, /organizationId=org_north/);
  assert.equal(del.body, undefined);

  const created = await lb.mutate({
    method: "POST",
    path: "/leads",
    organizationId: "org_north",
    body: { refId: "DNA-1" },
  });
  assert.equal(created.ok, true);
  const post = calls.find((call) => call.method === "POST");
  assert.deepEqual(post?.body, { refId: "DNA-1", organizationId: "org_north" });
});

test("get_lead finds the record in the second company", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/leads/lead_9")) {
      if (orgHeader(seen) === "org_south") {
        return { body: { id: "lead_9", name: "Hopper" } };
      }
      return { status: 404, body: { message: "Not found", code: "NOT_FOUND" } };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const found = await lb.readAcrossOrganizations("/leads/lead_9");
  assert.equal(found.hits.length, 1);
  const lead = found.hits[0].data as Record<string, unknown>;
  assert.equal(lead.name, "Hopper");
  assert.equal(lead.organizationId, "org_south");
  assert.equal(lead.organizationName, "South Acre Co");
  const leadCalls = calls.filter((call) => call.path.startsWith("/leads/lead_9"));
  assert.equal(leadCalls.length, 2);
});

test("list_campaigns uses cross-org search and can filter to one company", async () => {
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.path.startsWith("/cross-org/campaigns/search")) {
      return { body: [{ id: "camp_1", name: "DNA spring" }] };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const listed = await lb.listCampaigns({ query: "DNA", organizationId: "org_north" });
  assert.equal(listed.crossOrg, true);
  assert.match(calls[1].path, /\/cross-org\/campaigns\/search\?/);
  assert.match(calls[1].path, /query=DNA/);
  assert.equal(orgHeader(calls[1]), "org_north");
  const hit = (listed.results as Array<Record<string, unknown>>)[0];
  assert.equal(hit.organizationLabel, "North Acre Co (org_north)");
});

test("upload sends the company header and form field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-mcp-"));
  const filePath = join(dir, "shot.png");
  writeFileSync(filePath, "png");
  const { lb, calls } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.method === "POST") return { body: { id: "img_1" } };
    return { status: 500, body: { message: seen.path } };
  });

  const uploaded = await lb.upload({
    path: "/leads/lead_1/images",
    filePath,
    fields: { description: "caller id" },
    organizationId: "org_south",
  });
  assert.equal(uploaded.ok, true);
  const post = calls.find((call) => call.method === "POST");
  assert.equal(orgHeader(post!), "org_south");
  assert.equal(post?.form?.organizationId, "org_south");
  assert.equal(post?.form?.description, "caller id");
  assert.equal(post?.form?.file, "shot.png");
});

test("a backend ORGANIZATION_REQUIRED response is rewritten with the company list", async () => {
  const { lb } = client((seen) => {
    if (seen.path === "/cross-org/organizations") return { body: ORGS };
    if (seen.method === "POST") {
      return { status: 400, body: { code: "ORGANIZATION_REQUIRED", message: "Select an organization" } };
    }
    return { status: 500, body: { message: seen.path } };
  });

  const created = await lb.mutate({
    method: "POST",
    path: "/leads/lead_1/contact-notes",
    organizationId: "org_north",
    body: { content: "Called back" },
  });
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.error.error, "ORGANIZATION_REQUIRED");
  assert.deepEqual(created.error.organizations, ORGS.organizations);
});
