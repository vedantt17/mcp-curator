import yaml from "yaml";
import type { NormalizedSpec, NormalizedOp, NormalizedParam } from "./types";

export async function fetchAndNormalize(
  source: { kind: "url" | "inline"; value: string },
  baseUrlOverride?: string,
): Promise<NormalizedSpec> {
  let text: string;
  if (source.kind === "url") {
    let res: Response;
    try {
      res = await fetch(source.value);
    } catch (e) {
      throw new Error(`Could not reach ${source.value}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(`Spec URL returned ${res.status} ${res.statusText}. Check the URL is the raw OpenAPI document, not a docs page.`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    text = await res.text();
    if (contentType.includes("text/html") || /^\s*<(!doctype|html|head|body)/i.test(text)) {
      throw new Error(
        `That URL returned an HTML page, not an OpenAPI spec. You probably pasted a docs page — find the link labeled "Download OpenAPI", "openapi.json", or "swagger.json" on the docs site, or check the API's developer reference.`,
      );
    }
  } else {
    text = source.value;
  }
  const spec = parseSpec(text);
  return normalize(spec, baseUrlOverride);
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

function normalize(spec: any, baseUrlOverride?: string): NormalizedSpec {
  if (!spec.openapi && !spec.swagger) throw new Error("Not an OpenAPI/Swagger spec");
  const baseUrl = baseUrlOverride || spec.servers?.[0]?.url || "";
  if (!baseUrl) throw new Error("No baseUrl in spec; provide baseUrl override");

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
