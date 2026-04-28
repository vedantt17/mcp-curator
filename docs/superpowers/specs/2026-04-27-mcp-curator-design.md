# MCP Curator — Design Spec

**Date:** 2026-04-27
**Team:** Person A (backend/AI: Tanmay) · Person B (UI/CLI/deploy)
**Time budget:** 50 minutes

---

## 1. The idea

Paste an OpenAPI spec → Claude curates it into an LLM-optimized MCP tool set → installable with one `npx` command.

Curation is a Claude pass that:
- Picks the ≤12 most useful endpoints
- Drops destructive operations by default
- Merges related reads into composite tools
- Rewrites descriptions for LLM consumption with examples

Mechanical 1:1 OpenAPI→MCP converters already exist; this differs by using Claude to curate the surface instead of translating it.

## 2. Critical design choice — split AI from mechanical

| Claude does (judgment work) | Codegen does (mechanical work) |
|---|---|
| Pick which endpoints to expose | Emit fetch handlers from `composes[]` |
| Rewrite descriptions for agents | Inject auth headers from env |
| Decide on merges | Build URL with path/query params |
| Generate input JSON schemas | Validate inputs at runtime |

This isolates hallucination risk to descriptions/schemas (low cost if imperfect) and keeps fetch code deterministic (high cost if wrong). It also keeps Claude's output token count small → fewer typecheck failures → less retry latency.

## 3. Architecture

```
[Web UI]
  │
  └── POST /api/generate (SSE)
         │
         ├── parse spec (URL or pasted)
         ├── Claude curation pass → curated tools
         ├── mechanical codegen → server.ts
         ├── typecheck (+1 retry self-correction)
         └── store in KV  →  returns { id, mechanical, curated, code }

[Claude Desktop]
  │
  └── npx mcp-from-spec <id>
         │
         ├── GET /api/code/<id>
         ├── write index.ts + package.json to /tmp
         ├── npm install
         └── spawn tsx index.ts → MCP server (stdio)
```

## 4. Repo layout

```
mcp-curator/                          # Next.js app, deploys to Vercel
  app/
    page.tsx                          # paste UI + side-by-side
    api/generate/route.ts             # SSE: parse → curate → codegen → store
    api/code/[id]/route.ts            # GET: returns {code, deps, entrypoint}
  lib/
    openapi.ts                        # spec fetch + normalize (URL or pasted JSON/YAML)
    curator.ts                        # Claude call: returns curated tool list
    codegen.ts                        # template + render, mechanical handler emission
    storage.ts                        # Vercel KV (or in-memory Map fallback)
    typecheck.ts                      # ts-morph in-process; 1-retry self-correction
  prompts/curator.md                  # the system prompt (the IP)
  templates/server.ts.tmpl            # MCP server skeleton
  docs/superpowers/specs/
    2026-04-27-mcp-curator-design.md  # this file

mcp-from-spec/                        # separate npm package, zero runtime deps
  bin/cli.js
  package.json
```

## 5. API contracts

```ts
// POST /api/generate (Server-Sent Events)
type GenerateRequest = {
  source: { kind: "url"; value: string } | { kind: "inline"; value: string };  // JSON or YAML
  apiKeyEnv?: string;     // default: "API_KEY"
  baseUrl?: string;       // override if spec lacks `servers`
};

type GenerateEvent =
  | { event: "progress"; data: { stage: "parsing"|"curating"|"generating"|"typechecking"|"done"; msg?: string } }
  | { event: "result";   data: { id: string; mechanical: ToolMeta[]; curated: ToolMeta[]; code: string } }
  | { event: "error";    data: { message: string } };

type ToolMeta = {
  name: string;                                          // snake_case, verb_object
  description: string;                                   // LLM-friendly
  input_schema: JSONSchema7;
  composes: string[];                                    // operationIds it wraps
  examples?: { args: any; description: string }[];
};

// GET /api/code/[id]
type CodeResponse = {
  code: string;                                          // self-contained index.ts
  entrypoint: "index.ts";
  deps: { "@modelcontextprotocol/sdk": "^1.0.0" };       // generated server has 1 runtime dep
};
```

## 6. The curator prompt (skeleton)

```
You adapt OpenAPI specs into MCP tool sets optimized for LLM agents.

Given a normalized OpenAPI spec (operations array), output ONLY JSON matching:
{ "tools": [ { "name": string, "description": string, "input_schema": JSONSchema7,
               "composes": string[], "examples": [{ "args": any, "description": string }] } ] }

Curation rules (apply in order):
1. DROP destructive operations (DELETE, irreversible POST/PATCH) unless they are the entire purpose.
2. DROP duplicates and near-duplicates; keep the more general one.
3. MERGE read operations when a composite is meaningfully more useful than two calls
   (e.g., resource + sub-resource where sub is almost always wanted).
4. CAP at 12 tools. If more remain, keep the 12 most LLM-useful (broad utility, common workflows).
5. REWRITE every description: state PURPOSE, WHEN to use, WHEN NOT to use. ≤3 sentences.
6. Names: snake_case, verb_object form (e.g., send_email, get_user).
7. Input schema: only mark required fields the API truly requires. Use enums where the spec has them.
8. Examples: 1 per tool, realistic args, ≤120 char description.

Hard constraints:
- Output JSON only, no prose, no code fences.
- composes[] must reference real operationIds from the input.
- input_schema must validate as JSON Schema draft 7.

[Two worked examples baked here: Resend (write API), OpenWeather (read API)]
```

The two worked examples are the most load-bearing part of the prompt. Hand-author them before the event so they pin output style.

## 7. Server template

`templates/server.ts.tmpl`:

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = "__BASE_URL__";
const API_KEY = process.env.__API_KEY_ENV__;
if (!API_KEY) { console.error("Missing __API_KEY_ENV__"); process.exit(1); }

const TOOLS = __TOOLS_JSON__;

async function call(p: string, init: RequestInit & { query?: Record<string, any> } = {}) {
  const url = new URL(BASE_URL + p);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

const HANDLERS: Record<string, (args: any) => Promise<any>> = {
__HANDLERS__
};

const server = new Server({ name: "__NAME__", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const h = HANDLERS[req.params.name];
  if (!h) throw new Error(`Unknown tool: ${req.params.name}`);
  const out = await h(req.params.arguments ?? {});
  return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
});
await server.connect(new StdioServerTransport());
```

Mechanically-emitted handler example (curated tool composing one operation):

```ts
// Curated: send_email, composes: ["sendEmail"]
// Operation: POST /emails, body: { from, to, subject, html }
"send_email": async (args) => call("/emails", {
  method: "POST",
  body: JSON.stringify({ from: args.from, to: args.to, subject: args.subject, html: args.html })
}),
```

Handler emission is a small pure function over `(curatedTool, opLookup: Map<opId, OpenAPIOp>)`. Pull each composed op's method/path/params/body, template the fetch. ~80 lines of TS. No Claude involved.

## 8. CLI package — `mcp-from-spec`

`mcp-from-spec/bin/cli.js`:

```js
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");

const id = process.argv[2];
if (!id) { console.error("Usage: npx mcp-from-spec <id>"); process.exit(1); }

const base = process.env.MCP_CURATOR_URL || "https://mcp-curator.vercel.app";
const dir = path.join(os.tmpdir(), `mcp-${id}`);
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const r = await fetch(`${base}/api/code/${id}`);
  if (!r.ok) { console.error(`Fetch ${r.status}`); process.exit(1); }
  const { code, deps } = await r.json();
  fs.writeFileSync(path.join(dir, "index.ts"), code);
  fs.writeFileSync(path.join(dir, "package.json"),
    JSON.stringify({ name: `mcp-${id}`, version: "0.0.0", dependencies: { ...deps, tsx: "^4" } }, null, 2));
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    spawnSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  }
  const proc = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "index.ts"], { cwd: dir, stdio: "inherit", env: process.env });
  process.exit(proc.status ?? 0);
})();
```

`package.json`:

```json
{
  "name": "mcp-from-spec",
  "version": "0.1.0",
  "bin": { "mcp-from-spec": "bin/cli.js" },
  "engines": { "node": ">=18" }
}
```

`node_modules` are cached per-id in `os.tmpdir()` — second run is instant.

Claude Desktop config example:

```json
{
  "mcpServers": {
    "resend": {
      "command": "npx",
      "args": ["mcp-from-spec", "abc123"],
      "env": { "API_KEY": "re_xxx" }
    }
  }
}
```

## 9. Storage

```ts
type Stored = {
  code: string;
  deps: Record<string, string>;
  mechanical: ToolMeta[];
  curated: ToolMeta[];
  createdAt: number;
};

const mem = new Map<string, Stored>();
export const storage = process.env.KV_URL
  ? vercelKvAdapter()
  : { get: (id: string) => mem.get(id), set: (id: string, v: Stored) => mem.set(id, v) };
```

ID = `nanoid(8)`. Vercel KV in prod; in-memory fine for the demo if KV setup hits a snag (state lost across cold starts but the demo is one shot).

## 10. Self-correction loop

```ts
async function typecheckAndFix(code: string, attempt = 0): Promise<string> {
  const errors = await runTscNoEmit(code);          // ts-morph in-process, no shell
  if (!errors.length) return code;
  if (attempt >= 1) throw new Error("typecheck failed after retry");
  const fixed = await claude.messages.create({
    model: "claude-opus-4-7",
    system: "Fix the TypeScript errors. Return ONLY the corrected file, no prose.",
    messages: [{ role: "user", content: `Errors:\n${errors.join("\n")}\n\nCode:\n${code}` }],
  });
  return typecheckAndFix(extractCode(fixed), attempt + 1);
}
```

Cap: 1 retry. If still broken, fall back to a mechanical 1:1 server (skip curation, dump every operation as a tool). Always-valid fallback path means the demo can't fully fail.

## 11. Dependencies

**Web app:**

```json
{
  "next": "15",
  "@anthropic-ai/sdk": "^0.32",
  "@vercel/kv": "^3",
  "nanoid": "^5",
  "yaml": "^2",
  "ts-morph": "^24"
}
```

**Generated server (runtime):**

```json
{ "@modelcontextprotocol/sdk": "^1.0.0" }
```

**CLI:** zero deps, node built-ins only.

## 12. Deployment

```bash
# Web app
cd mcp-curator
vercel link
vercel env add ANTHROPIC_API_KEY production
vercel --prod
# Capture URL → use as MCP_CURATOR_URL default in CLI

# CLI
cd mcp-from-spec
npm publish --access public
```

## 13. 50-minute timeline

| Time   | Person A (curator + codegen + typecheck)                             | Person B (UI + CLI + storage + deploy)                              |
|--------|----------------------------------------------------------------------|---------------------------------------------------------------------|
| 0–5    | Repo init; paste pre-written `prompts/curator.md` + server template  | `git init`, push to GitHub; scaffold paste UI; init CLI package     |
| 5–15   | Build `lib/openapi.ts` (fetch + parse JSON/YAML, normalize ops)      | SSE client in UI; pretty progress states; `npm link` test of CLI    |
| 15–25  | Build `lib/curator.ts`: send normalized ops → Claude → parse tools   | Side-by-side compare component; "Copy Claude Desktop config" button |
| 25–35  | Build `lib/codegen.ts`: mechanical handler emission                  | Wire `lib/storage.ts`; `/api/code/[id]` route; `npm publish` CLI    |
| 35–45  | Add `lib/typecheck.ts` self-correction loop; mechanical fallback     | `vercel --prod`; smoke test full flow Resend → npx → Claude Desktop |
| 45–50  | Cross-test together — fresh spec, end-to-end, twice                  | Same                                                                |

## 14. Pre-event prep (tonight)

- [ ] Hand-author the two worked examples in `curator.md` (Resend + OpenWeather)
- [ ] Pre-test 3 OpenAPI specs end-to-end: Resend, OpenWeather, NASA APOD
- [ ] Person B publishes CLI v0.1.0 to npm (warms cache; locks the name)
- [ ] Vercel deploy URL hardcoded as fallback in CLI
- [ ] Demo laptop has `ANTHROPIC_API_KEY`, `RESEND_API_KEY` in env
- [ ] Claude Desktop config template ready to paste
- [ ] One offline-cached generated server stored locally as final fallback

## 15. Risk register

| Risk                                          | Mitigation                                                                                                |
|-----------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Generated code doesn't compile                | Few-shot prompt + `ts-morph` typecheck + 1-retry self-correction; mechanical fallback never fails         |
| Curation produces inconsistent tool counts    | Prompt locks: max 12, must include examples, must skip destructive endpoints                              |
| Stage wifi dies                               | Pre-cache one demo spec + generated code locally; CLI falls back to local file if API unreachable         |
| OAuth APIs                                    | Out of scope — ship "API key auth supported, OAuth in beta" message                                       |
| Live API call fails on stage (e.g. Resend)    | Backup spec is OpenWeather (read-only, can't fail destructively)                                          |
| `npm publish` collides with existing name     | Reserve name + publish v0.0.0 stub the night before                                                       |

## 16. Out of scope (explicitly)

- OAuth / OAuth 2.1 flows
- Hosted SSE/HTTP MCP servers (we ship stdio + npx)
- Multi-spec composition (one spec per server)
- Claude Desktop deeplink installer (`claude://`) — nice-to-have if time permits, not in MVP
- Auth flows beyond Bearer / API key header
- Webhook / streaming endpoints
- File upload endpoints (multipart)

