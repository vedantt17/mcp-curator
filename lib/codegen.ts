import { promises as fs } from "fs";
import path from "path";
import type { NormalizedSpec, NormalizedOp, ToolMeta } from "./types";

let cachedTemplate: string | null = null;
async function loadTemplate(): Promise<string> {
  if (cachedTemplate) return cachedTemplate;
  const p = path.join(process.cwd(), "templates", "server.ts.tmpl");
  cachedTemplate = await fs.readFile(p, "utf-8");
  return cachedTemplate;
}

export async function generateServer(
  spec: NormalizedSpec,
  curated: ToolMeta[],
  apiKeyEnv: string,
): Promise<string> {
  const tmpl = await loadTemplate();
  const opLookup = new Map(spec.ops.map((op) => [op.operationId, op]));

  const handlers = curated.map((t) => emitHandler(t, opLookup)).join(",\n");

  const auth =
    spec.authStyle === "bearer"
      ? { header: `"Authorization"`, value: "`Bearer ${API_KEY}`" }
      : { header: JSON.stringify(spec.authParam || "X-API-Key"), value: "API_KEY" };

  return tmpl
    .replace(/__BASE_URL__/g, spec.baseUrl)
    .replace(/__API_KEY_ENV__/g, apiKeyEnv)
    .replace(/__TOOLS_JSON__/g, JSON.stringify(curated, null, 2))
    .replace(/__HANDLERS__/g, handlers)
    .replace(/__NAME__/g, spec.name)
    .replace(/__AUTH_HEADER__/g, auth.header)
    .replace(/__AUTH_VALUE__/g, auth.value);
}

function emitHandler(tool: ToolMeta, ops: Map<string, NormalizedOp>): string {
  const ids = tool.composes;
  if (ids.length === 1) {
    const op = ops.get(ids[0]);
    if (!op) throw new Error(`emitHandler: unknown op ${ids[0]}`);
    return `  ${JSON.stringify(tool.name)}: async (args) => ${emitFetchCall(op)}`;
  }

  const oneOf: any[] | undefined = tool.input_schema?.oneOf;
  const useOneOf = Array.isArray(oneOf) && oneOf.length === ids.length;

  const requiredPerBranch: string[][] = ids.map((id, i) => {
    if (useOneOf) {
      const r = oneOf![i]?.required;
      return Array.isArray(r) ? r : [];
    }
    const op = ops.get(id);
    if (!op) throw new Error(`emitHandler: unknown op ${id}`);
    const requiredParams = (op.parameters ?? [])
      .filter((p) => p.required && p.in !== "header")
      .map((p) => p.name);
    const requiredBody = op.requestBody?.schema?.required ?? [];
    return [...requiredParams, ...requiredBody];
  });

  const emptyBranches = requiredPerBranch.filter((r) => r.length === 0).length;
  if (emptyBranches > 1) {
    // Ambiguous dispatch (multiple branches with no required-arg discriminator).
    // Degrade to single-op behavior using the first composed op rather than failing codegen.
    const firstOp = ops.get(ids[0]);
    if (!firstOp) throw new Error(`emitHandler: unknown op ${ids[0]}`);
    return `  ${JSON.stringify(tool.name)}: async (args) => ${emitFetchCall(firstOp)}`;
  }

  const branches = ids
    .map((id, i) => {
      const op = ops.get(id);
      if (!op) throw new Error(`emitHandler: unknown op ${id}`);
      const allRequired = requiredPerBranch[i];
      const cond =
        allRequired.length === 0
          ? "true"
          : allRequired.map((n) => `args[${JSON.stringify(n)}] != null`).join(" && ");
      return `    if (${cond}) return ${emitFetchCall(op)};`;
    })
    .join("\n");

  return `  ${JSON.stringify(tool.name)}: async (args) => {\n${branches}\n    throw new Error("No matching operation for given args");\n  }`;
}

function emitFetchCall(op: NormalizedOp): string {
  let pathExpr = JSON.stringify(op.path);
  for (const p of (op.parameters ?? []).filter((p) => p.in === "path")) {
    pathExpr = `${pathExpr}.replaceAll(${JSON.stringify(`{${p.name}}`)}, encodeURIComponent(String(args[${JSON.stringify(p.name)}])))`;
  }

  const queryParams = (op.parameters ?? []).filter((p) => p.in === "query");
  const queryObj =
    queryParams.length === 0
      ? ""
      : `, query: { ${queryParams
          .map((p) => `${JSON.stringify(p.name)}: args[${JSON.stringify(p.name)}]`)
          .join(", ")} }`;

  const pathQueryNames = (op.parameters ?? [])
    .filter((p) => p.in === "path" || p.in === "query")
    .map((p) => p.name);

  const bodySchema = op.requestBody?.schema;
  const bodyKeys = bodySchema?.properties ? Object.keys(bodySchema.properties) : [];
  const bodyExpr = !bodySchema
    ? ""
    : bodyKeys.length > 0
      ? `, body: JSON.stringify({ ${bodyKeys
          .map((k) => `${JSON.stringify(k)}: args[${JSON.stringify(k)}]`)
          .join(", ")} })`
      : `, body: JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !${JSON.stringify(pathQueryNames)}.includes(k))))`;

  return `call(${pathExpr}, { method: ${JSON.stringify(op.method)}${queryObj}${bodyExpr} })`;
}
