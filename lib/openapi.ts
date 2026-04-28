import yaml from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import type { NormalizedSpec, NormalizedOp, NormalizedParam } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type FetchProgress = (event: "discovering" | "redirecting" | "generating-spec", msg: string) => void;

function isHtml(contentType: string, text: string): boolean {
  return contentType.includes("text/html") || /^\s*<(!doctype|html|head|body)/i.test(text);
}

async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Could not reach ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status} ${res.statusText}.`);
  }
  return { text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
}

async function generateSpecFromKnowledge(
  sourceUrl: string,
  html: string | null,
): Promise<{ spec: any; baseUrl: string } | null> {
  const trimmed = html ? html.slice(0, 20_000) : "";
  let hostname = "";
  try {
    hostname = new URL(sourceUrl).hostname;
  } catch {
    // ignore
  }

  const response = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 4000,
    system: `You generate minimal OpenAPI 3.0 specs for public REST APIs using a URL and your training knowledge.

You will receive a URL the user pasted. Often it's a marketing page, blog post, or generic docs page that doesn't itself contain a spec. Your job is to figure out what API the user probably wants to call and emit a usable OpenAPI 3.0 spec for it.

DEFAULT TO BEING HELPFUL. Most pasted URLs come from companies that DO have a public REST API even if the page isn't the API docs page. Use the hostname as your primary signal.

Examples of mappings you should make confidently:
- *.postman.com → Postman API at https://api.getpostman.com (collections, workspaces, environments, monitors)
- *.stripe.com → Stripe API at https://api.stripe.com/v1 (charges, customers, subscriptions, payment_intents)
- *.github.com → GitHub REST API at https://api.github.com (repos, issues, pulls, releases)
- *.notion.so → Notion API at https://api.notion.com/v1 (pages, databases, users, blocks)
- *.linear.app → GraphQL only; output UNKNOWN
- *.openweathermap.org → OpenWeather at https://api.openweathermap.org/data/2.5
- *.twilio.com → Twilio at https://api.twilio.com/2010-04-01
- *.sendgrid.com → SendGrid at https://api.sendgrid.com/v3
- *.airtable.com → Airtable at https://api.airtable.com/v0
- *.shopify.com → Shopify Admin API at https://{shop}.myshopify.com/admin/api/{version}

If you recognize the company/product (from hostname or page content) and know its REST API, generate the spec. It's OK to extrapolate — the spec is a starting point, not legal commitment. Cover the 8-12 most useful endpoints.

Only output UNKNOWN if:
- The URL points to something that has no API (a blog, news site, individual person's homepage)
- The company exists but you genuinely don't know their API base URL or endpoints
- The product is GraphQL-only or otherwise not REST

Output rules:
- JSON only — no markdown, no code fences, no prose, no comments.
- Required fields: openapi: "3.0.0", info { title, version }, servers[0].url (real production base URL), paths.
- 8-12 path entries covering the most useful endpoints.
- Every operation: operationId, summary, parameters/requestBody as appropriate, response schemas optional.
- Add "x-generated": true at root.

Hostname: ${hostname}
Pasted URL: ${sourceUrl}`,
    messages: [
      {
        role: "user",
        content: trimmed
          ? `Page content (excerpt):\n\n${trimmed}\n\nIdentify the API and generate its OpenAPI spec, or output UNKNOWN if there is genuinely no public REST API to target.`
          : `Identify the API at ${sourceUrl} and generate its OpenAPI spec, or output UNKNOWN if there is genuinely no public REST API to target.`,
      },
    ],
  });

  const block = response.content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (!block) return null;
  let text = block.text.trim();
  if (!text || text === "UNKNOWN") return null;
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    const parsed = JSON.parse(text);
    if (!parsed.openapi && !parsed.swagger) return null;
    if (!parsed.paths || Object.keys(parsed.paths).length === 0) return null;
    const baseUrl = parsed.servers?.[0]?.url;
    if (!baseUrl || typeof baseUrl !== "string") return null;
    return { spec: parsed, baseUrl };
  } catch {
    return null;
  }
}

async function discoverSpecUrl(html: string, sourceUrl: string): Promise<string | null> {
  // Trim to keep token use reasonable. Bias to the head + body start where links usually live.
  const trimmed = html.length > 80_000 ? html.slice(0, 60_000) + "\n...[truncated]...\n" + html.slice(-20_000) : html;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: `You find URLs to OpenAPI/Swagger spec files on documentation pages.

Given the HTML of a docs/landing page, return the URL where the OpenAPI JSON or YAML spec can be downloaded.

Look for:
- <a> links with href ending in openapi.json, openapi.yaml, swagger.json, swagger.yaml, api.json, spec.json
- Anchor text like "Download OpenAPI", "openapi.json", "swagger.json", "Download Spec", "Raw OpenAPI"
- <link rel="alternate" type="application/openapi+json"> or similar
- Embedded data attributes / script JSON that point at a spec URL (Scalar, ReDoc, Stoplight, RapiDoc embed it)
- Common conventional paths on the same origin: /openapi.json, /api/openapi.json, /v1/openapi.json, /spec, /swagger.json

Output rules:
- Return ONLY a single absolute URL on the first line, or the literal word NONE.
- Resolve relative URLs against the page's URL (provided below).
- Prefer JSON over YAML. Prefer same-origin or sibling subdomains.
- Do NOT return URLs that point to docs pages, blog posts, or GitHub README files.
- Do NOT include any explanation, markdown, or quotes.

Page URL: ${sourceUrl}`,
    messages: [
      { role: "user", content: `HTML:\n\n${trimmed}\n\nSpec URL?` },
    ],
  });

  const block = response.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined;
  if (!block) return null;
  const first = block.text.trim().split("\n")[0]?.trim();
  if (!first || first === "NONE") return null;
  if (!/^https?:\/\//i.test(first)) return null;
  return first;
}

export async function fetchAndNormalize(
  source: { kind: "url" | "inline"; value: string },
  baseUrlOverride?: string,
  onProgress?: FetchProgress,
): Promise<NormalizedSpec> {
  let text: string;
  let resolvedSpecUrl: string | undefined;

  if (source.kind === "url") {
    const initial = await fetchText(source.value);
    text = initial.text;
    resolvedSpecUrl = source.value;

    if (isHtml(initial.contentType, text)) {
      onProgress?.("discovering", `looks like a docs page — asking Claude to find the spec URL...`);
      const discovered = await discoverSpecUrl(text, source.value);

      if (discovered) {
        onProgress?.("redirecting", `found ${discovered} — fetching...`);
        const followed = await fetchText(discovered);
        if (isHtml(followed.contentType, followed.text)) {
          // discovered URL is also HTML — fall through to generation
          onProgress?.("generating-spec", `discovered URL also returned HTML — generating spec from training knowledge...`);
          const generated = await generateSpecFromKnowledge(source.value, text);
          if (!generated) {
            throw new Error(
              `Could not find a downloadable OpenAPI spec on that page, and Claude couldn't generate one from its training knowledge either. Try a more specific docs URL, or paste the raw spec.`,
            );
          }
          return normalize(generated.spec, baseUrlOverride, generated.baseUrl);
        }
        text = followed.text;
        resolvedSpecUrl = discovered;
      } else {
        // No spec link found on the page — try generation as a last resort.
        onProgress?.("generating-spec", `no spec link found — generating from training knowledge...`);
        const generated = await generateSpecFromKnowledge(source.value, text);
        if (!generated) {
          throw new Error(
            `That URL returned an HTML page, no spec link was found on it, and Claude couldn't identify the API from its training knowledge. ` +
            `Try a URL closer to the actual API docs (not a marketing page), or paste the raw OpenAPI spec.`,
          );
        }
        return normalize(generated.spec, baseUrlOverride, generated.baseUrl);
      }
    }
  } else {
    text = source.value;
  }

  const spec = parseSpec(text);
  return normalize(spec, baseUrlOverride, resolvedSpecUrl);
}

function parseSpec(text: string): any {
  const trimmed = text.trim().replace(/^﻿/, ""); // strip BOM
  if (!trimmed) throw new Error("Spec is empty");
  if (trimmed.startsWith("<")) {
    throw new Error("Input looks like HTML/XML, not an OpenAPI spec. Paste a raw JSON or YAML OpenAPI document.");
  }
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    return yaml.parse(trimmed);
  } catch (e) {
    throw new Error(`Could not parse spec as JSON or YAML: ${(e as Error).message}`);
  }
}

function normalize(spec: any, baseUrlOverride?: string, sourceUrl?: string): NormalizedSpec {
  if (!spec.openapi && !spec.swagger) throw new Error("Not an OpenAPI/Swagger spec");

  let baseUrl = baseUrlOverride || spec.servers?.[0]?.url || "";

  // Swagger 2.0 fallback: construct from host + basePath + schemes
  if (!baseUrl && spec.swagger && spec.host) {
    const scheme = (Array.isArray(spec.schemes) && spec.schemes[0]) || "https";
    baseUrl = `${scheme}://${spec.host}${spec.basePath || ""}`;
  }

  // Last-resort fallback: use the origin of the URL we fetched the spec from.
  // The OpenAPI spec says when servers[] is omitted, the API is served from where
  // the spec is hosted — so this matches the spec's own semantics.
  if (!baseUrl && sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {
      // ignore — fall through to error below
    }
  }

  if (!baseUrl) {
    throw new Error(
      `Spec has no servers[] and we could not infer a base URL. ` +
      `If the API is reachable at a known origin, paste a JSON spec with a "servers" array, or call this with a baseUrl override.`,
    );
  }

  const name = (spec.info?.title || "api")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "api";

  const auth = detectAuth(spec);

  const ops: NormalizedOp[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const methodsAny = methods as any;
    const pathLevelParams: NormalizedParam[] = (methodsAny.parameters || []).map((p: any) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      schema: p.schema,
      description: p.description,
    }));

    for (const [method, op] of Object.entries(methodsAny)) {
      const m = method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
      const opAny = op as any;
      const operationId =
        opAny.operationId || `${m}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`.toLowerCase();

      const opParams: NormalizedParam[] = (opAny.parameters || []).map((p: any) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        schema: p.schema,
        description: p.description,
      }));

      const seen = new Set(opParams.map((p) => `${p.name}:${p.in}`));
      const params = [
        ...opParams,
        ...pathLevelParams.filter((p) => !seen.has(`${p.name}:${p.in}`)),
      ];

      const bodySchema = opAny.requestBody?.content?.["application/json"]?.schema;
      const requestBody = opAny.requestBody
        ? { required: opAny.requestBody.required, schema: bodySchema }
        : undefined;

      ops.push({
        operationId,
        method: m.toUpperCase() as NormalizedOp["method"],
        path,
        summary: opAny.summary,
        description: opAny.description,
        parameters: params.length ? params : undefined,
        requestBody,
      });
    }
  }

  return { name, baseUrl, authStyle: auth.style, authParam: auth.param, ops };
}

function detectAuth(spec: any): { style: "bearer" | "apiKey-header"; param?: string } {
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  for (const s of Object.values(schemes) as any[]) {
    if (s.type === "http" && s.scheme === "bearer") return { style: "bearer" };
    if (s.type === "apiKey" && s.in === "header") return { style: "apiKey-header", param: s.name };
  }
  return { style: "bearer" };
}
