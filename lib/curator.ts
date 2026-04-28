import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import type { NormalizedSpec, NormalizedOp, ToolMeta } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let cachedPrompt: string | null = null;
async function loadPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(process.cwd(), "prompts", "curator.md");
  cachedPrompt = await fs.readFile(p, "utf-8");
  return cachedPrompt;
}

export async function curate(spec: NormalizedSpec): Promise<ToolMeta[]> {
  const system = await loadPrompt();

  const compactOps = spec.ops.map((op) => ({
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary,
    parameters: op.parameters,
    requestBody: op.requestBody,
  }));

  const userMessage = JSON.stringify({ operations: compactOps }, null, 2);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (!textBlock) throw new Error("No text response from Claude");

  return parseAndValidate(textBlock.text, spec.ops);
}

function parseAndValidate(raw: string, ops: NormalizedOp[]): ToolMeta[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text);
  if (!parsed.tools || !Array.isArray(parsed.tools)) {
    throw new Error("Curated output missing `tools` array");
  }
  const tools: ToolMeta[] = parsed.tools;
  if (tools.length === 0) throw new Error("No curated tools returned");
  if (tools.length > 12) throw new Error(`Too many tools: ${tools.length} (cap 12)`);

  const opIds = new Set(ops.map((o) => o.operationId));
  for (const t of tools) {
    if (!t.name || !/^[a-z][a-z0-9_]*$/.test(t.name)) throw new Error(`Bad name: ${t.name}`);
    if (!t.description) throw new Error(`Tool ${t.name} missing description`);
    if (!t.input_schema) throw new Error(`Tool ${t.name} missing input_schema`);
    if (!Array.isArray(t.composes) || t.composes.length === 0) {
      throw new Error(`Tool ${t.name} missing composes`);
    }
    for (const id of t.composes) {
      if (!opIds.has(id)) throw new Error(`Tool ${t.name} references unknown op ${id}`);
    }
  }
  return tools;
}

export function mechanicalToolList(spec: NormalizedSpec): ToolMeta[] {
  return spec.ops.map((op) => ({
    name: op.operationId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
    description: op.summary || op.description || `${op.method} ${op.path}`,
    input_schema: buildMechanicalSchema(op),
    composes: [op.operationId],
  }));
}

function buildMechanicalSchema(op: NormalizedOp): any {
  const props: Record<string, any> = {};
  const required: string[] = [];
  for (const p of op.parameters ?? []) {
    props[p.name] = p.schema || { type: "string" };
    if (p.required) required.push(p.name);
  }
  if (op.requestBody?.schema?.properties) {
    Object.assign(props, op.requestBody.schema.properties);
    for (const r of op.requestBody.schema.required ?? []) required.push(r);
  }
  return { type: "object", properties: props, required };
}
