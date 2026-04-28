# Person B — Build Plan

You're building **MCP Curator** with Tanmay. 50-minute build window.

**What it is:** paste an OpenAPI spec → Claude curates a smart MCP tool set (≤12 tools, rewritten descriptions, merged operations) → installable with one `npx` command.

Read `docs/superpowers/specs/2026-04-27-mcp-curator-design.md` for the full design. This file is your action list.

---

## Your scope

**You own:** git repo, web UI, SSE client, `mcp-from-spec` npm package, storage layer, `/api/code/[id]` route, Vercel deploy, npm publish.

**Tanmay owns:** `prompts/curator.md`, `lib/curator.ts`, `lib/codegen.ts`, `lib/openapi.ts`, `lib/typecheck.ts`, `/api/generate` route internals.

**Your boundary with Tanmay** is the API contract in section "API contract you can rely on" below. Build against it; don't touch his files.

---

## Pre-event homework (do tonight)

- [ ] Have Node 20+ and npm installed
- [ ] Have a GitHub account with SSH set up
- [ ] `npm login` — confirm you can publish (whoami should return your handle)
- [ ] `npm install -g vercel` and `vercel login`
- [ ] Reserve the npm package name: `npm publish` a v0.0.0 stub of `mcp-from-spec` so nobody else takes it
  - Quick stub: a folder with `package.json` (`"name": "mcp-from-spec", "version": "0.0.0", "bin": {"mcp-from-spec": "bin/cli.js"}`) and `bin/cli.js` printing "stub"
  - If `mcp-from-spec` is taken, use a scoped name like `@yourhandle/mcp-from-spec` and update the spec
- [ ] Install Claude Desktop, sign in, locate the config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac, `%APPDATA%\Claude\claude_desktop_config.json` on Windows)
- [ ] Get the Anthropic API key from Tanmay (he'll add it to Vercel env, you don't need it locally)
- [ ] Get a Resend API key for the live demo (free tier, takes 2 min)

---

## Build plan (in order, with time budget)

### Task 1 — Repo + scaffolding (0–5 min)

```bash
# Project root assumed: ./mcp-curator (already exists; the spec is in docs/superpowers/specs)
cd mcp-curator
git init
git branch -M main
gh repo create mcp-curator --private --source=. --remote=origin
git add -A && git commit -m "chore: initial spec"
git push -u origin main

npx create-next-app@latest . --typescript --app --no-tailwind --no-src-dir --no-eslint --use-npm
# When prompted: keep existing files (the spec lives in docs/), import alias default
npm i @anthropic-ai/sdk @vercel/kv nanoid yaml ts-morph
mkdir -p lib prompts templates app/api/generate app/api/code/'[id]'

# Sibling package for the CLI
cd ..
mkdir -p mcp-from-spec/bin
```

Acceptance: `mcp-curator/` is a Next.js app pushed to GitHub, `mcp-from-spec/` exists with `bin/`.

---

### Task 2 — Web UI shell (5–15 min)

Replace `app/page.tsx` with the paste form + SSE client. Wire it to a stub `/api/generate` so you can test before Tanmay's endpoint exists.

`app/page.tsx`:

```tsx
"use client";
import { useState } from "react";

type ToolMeta = {
  name: string; description: string; input_schema: any;
  composes: string[]; examples?: { args: any; description: string }[];
};

type Result = { id: string; mechanical: ToolMeta[]; curated: ToolMeta[]; code: string };

export default function Page() {
  const [specInput, setSpecInput] = useState("https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json");
  const [apiKeyEnv, setApiKeyEnv] = useState("API_KEY");
  const [stage, setStage] = useState<string>("");
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setStage("starting"); setResult(null); setErr(null);
    const isUrl = /^https?:\/\//.test(specInput);
    const res = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: isUrl ? { kind: "url", value: specInput } : { kind: "inline", value: specInput },
        apiKeyEnv,
      }),
    });
    if (!res.body) { setErr("no stream"); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n"); buf = events.pop() ?? "";
      for (const e of events) {
        const eventLine = e.split("\n").find(l => l.startsWith("event:"))?.slice(6).trim();
        const dataLine  = e.split("\n").find(l => l.startsWith("data:"))?.slice(5).trim();
        if (!eventLine || !dataLine) continue;
        const data = JSON.parse(dataLine);
        if (eventLine === "progress") setStage(data.stage);
        if (eventLine === "result")   { setResult(data); setStage("done"); }
        if (eventLine === "error")    setErr(data.message);
      }
    }
  }

  return (
    <main style={{ maxWidth: 1200, margin: "40px auto", padding: 24, fontFamily: "ui-sans-serif" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>MCP Curator</h1>
      <p style={{ color: "#555" }}>Paste an OpenAPI spec. Get a Claude-curated MCP server.</p>
      <textarea value={specInput} onChange={e => setSpecInput(e.target.value)}
        rows={6} style={{ width: "100%", marginTop: 16, fontFamily: "monospace", padding: 12 }} />
      <div style={{ marginTop: 8 }}>
        <label>API key env var: </label>
        <input value={apiKeyEnv} onChange={e => setApiKeyEnv(e.target.value)}
          style={{ fontFamily: "monospace", padding: 6 }} />
      </div>
      <button onClick={generate} disabled={stage !== "" && stage !== "done"}
        style={{ marginTop: 12, padding: "10px 20px", fontSize: 16, background: "#000", color: "#fff", border: 0 }}>
        Generate
      </button>
      {stage && <div style={{ marginTop: 12, color: "#666" }}>Stage: {stage}</div>}
      {err && <div style={{ marginTop: 12, color: "crimson" }}>Error: {err}</div>}
      {result && <Compare result={result} />}
    </main>
  );
}

function Compare({ result }: { result: Result }) {
  const cfg = JSON.stringify({
    mcpServers: { server: { command: "npx", args: ["mcp-from-spec", result.id], env: { API_KEY: "<paste-here>" } } },
  }, null, 2);
  return (
    <div style={{ marginTop: 32 }}>
      <h2>id: <code>{result.id}</code></h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <Pane title={`Mechanical: ${result.mechanical.length} tools`} tools={result.mechanical} muted />
        <Pane title={`Claude-curated: ${result.curated.length} tools`} tools={result.curated} />
      </div>
      <h3 style={{ marginTop: 32 }}>Claude Desktop config</h3>
      <pre style={{ background: "#f5f5f5", padding: 12, fontSize: 12 }}>{cfg}</pre>
      <button onClick={() => navigator.clipboard.writeText(cfg)}
        style={{ padding: "8px 16px", marginTop: 4 }}>Copy config</button>
      <h3 style={{ marginTop: 32 }}>Install command</h3>
      <pre style={{ background: "#f5f5f5", padding: 12 }}>npx mcp-from-spec {result.id}</pre>
    </div>
  );
}

function Pane({ title, tools, muted }: { title: string; tools: ToolMeta[]; muted?: boolean }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, opacity: muted ? 0.7 : 1 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {tools.map(t => (
        <details key={t.name} style={{ marginBottom: 8 }}>
          <summary style={{ fontFamily: "monospace", fontWeight: 600 }}>{t.name}</summary>
          <p style={{ fontSize: 13, color: "#444" }}>{t.description}</p>
          {t.examples?.[0] && (
            <pre style={{ fontSize: 11, background: "#f9f9f9", padding: 8 }}>
              {JSON.stringify(t.examples[0].args, null, 2)}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}
```

**Stub `/api/generate`** so you can test the UI without Tanmay (delete once he's done):

`app/api/generate/route.ts`:

```ts
export const runtime = "nodejs";
export async function POST() {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("progress", { stage: "parsing" });
      await new Promise(r => setTimeout(r, 300));
      send("progress", { stage: "curating" });
      await new Promise(r => setTimeout(r, 600));
      send("result", {
        id: "stub123",
        mechanical: [{ name: "send_email", description: "...", input_schema: {}, composes: ["sendEmail"] }],
        curated:    [{ name: "send_email", description: "Send transactional email via Resend.", input_schema: {}, composes: ["sendEmail"], examples: [{ args: { from: "a@b.c", to: "x@y.z", subject: "hi", html: "<p>hi</p>" }, description: "basic send" }] }],
        code: "// stub",
      });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
```

Acceptance: `npm run dev`, paste any URL, click Generate, see two panes side-by-side with stub data.

---

### Task 3 — Storage + `/api/code/[id]` (15–25 min)

`lib/storage.ts`:

```ts
import { kv } from "@vercel/kv";

export type Stored = {
  code: string;
  deps: Record<string, string>;
  mechanical: any[];
  curated: any[];
  createdAt: number;
};

const useKV = !!process.env.KV_URL;
const mem = new Map<string, Stored>();

export const storage = {
  async get(id: string): Promise<Stored | null> {
    return useKV ? (await kv.get<Stored>(`code:${id}`)) : (mem.get(id) ?? null);
  },
  async set(id: string, v: Stored): Promise<void> {
    if (useKV) await kv.set(`code:${id}`, v, { ex: 60 * 60 * 24 * 7 });
    else mem.set(id, v);
  },
};
```

`app/api/code/[id]/route.ts`:

```ts
import { storage } from "@/lib/storage";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const s = await storage.get(params.id);
  if (!s) return new Response("not found", { status: 404 });
  return Response.json({
    code: s.code,
    entrypoint: "index.ts",
    deps: s.deps ?? { "@modelcontextprotocol/sdk": "^1.0.0" },
  });
}
```

Acceptance: with the stub `/api/generate` returning id `stub123`, manually `storage.set("stub123", ...)` in a test, hit `/api/code/stub123`, get JSON back.

---

### Task 4 — `mcp-from-spec` CLI package (25–35 min)

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
  if (!r.ok) { console.error(`Fetch ${r.status}: ${await r.text()}`); process.exit(1); }
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

`mcp-from-spec/package.json`:

```json
{
  "name": "mcp-from-spec",
  "version": "0.1.0",
  "description": "Run a Claude-curated MCP server from an MCP Curator id",
  "bin": { "mcp-from-spec": "bin/cli.js" },
  "engines": { "node": ">=18" },
  "files": ["bin"],
  "license": "MIT"
}
```

Test locally before publishing:
```bash
cd mcp-from-spec
chmod +x bin/cli.js
npm link
MCP_CURATOR_URL=http://localhost:3000 mcp-from-spec stub123
# should fetch your stubbed code and try to run it
```

Then publish:
```bash
npm publish --access public
```

Acceptance: `npx mcp-from-spec@latest <id>` works against your local Vercel URL once Tanmay's endpoint is live.

---

### Task 5 — Deploy (35–45 min)

```bash
cd mcp-curator
vercel link        # link to Vercel project
vercel env add ANTHROPIC_API_KEY production    # paste key from Tanmay
vercel kv create mcp-curator-kv                # provision KV (or skip → in-memory)
# vercel env pull .env.local                   # if you want to test locally with KV
vercel --prod
# Capture the URL. Update CLI default:
```

If the deployed URL isn't `https://mcp-curator.vercel.app`, edit `mcp-from-spec/bin/cli.js` to hardcode the actual URL, bump version, republish.

Smoke test the live demo path:
1. Open the deployed URL
2. Paste Resend's OpenAPI URL (or whichever Tanmay confirms works)
3. Click Generate; wait for `done`
4. Copy the id
5. In a terminal: `API_KEY=<resend-key> npx mcp-from-spec <id>` — should print "MCP server running" or similar
6. Add to Claude Desktop config; restart Claude Desktop; confirm tools appear

Acceptance: full chain works from URL paste → tool callable in Claude Desktop.

---

### Task 6 — Cross-test with Tanmay (45–50 min)

Run the demo flow twice, top-to-bottom, with both backup specs:
- Resend (write — live email)
- OpenWeather (read — safe fallback)

Sanity checks:
- [ ] Side-by-side actually shows different counts (mechanical > curated)
- [ ] Curated descriptions read better than mechanical
- [ ] "Copy config" button copies valid JSON
- [ ] `npx mcp-from-spec <id>` works on a fresh terminal
- [ ] Claude Desktop shows the tools after restart
- [ ] One end-to-end "send email" or "get weather" call succeeds

If anything breaks: don't fix, fall back. Mechanical-only output should always work as a safety net.

---

## API contract you can rely on

This is the contract Tanmay will satisfy. Build against this; if he's late, your stub keeps the UI alive.

```ts
// POST /api/generate (Server-Sent Events)
type GenerateRequest = {
  source: { kind: "url"; value: string } | { kind: "inline"; value: string };
  apiKeyEnv?: string;     // default "API_KEY"
  baseUrl?: string;       // override if spec lacks `servers`
};

type GenerateEvent =
  | { event: "progress"; data: { stage: "parsing"|"curating"|"generating"|"typechecking"|"done"; msg?: string } }
  | { event: "result";   data: {
      id: string;
      mechanical: ToolMeta[];   // 1:1 from operations
      curated: ToolMeta[];      // <=12, descriptions rewritten, possibly merged
      code: string;             // full TS source for the MCP server
    } }
  | { event: "error";    data: { message: string } };

type ToolMeta = {
  name: string;
  description: string;
  input_schema: any;             // JSON Schema draft 7
  composes: string[];            // operationIds
  examples?: { args: any; description: string }[];
};

// GET /api/code/[id]
type CodeResponse = {
  code: string;
  entrypoint: "index.ts";
  deps: Record<string, string>;  // typically { "@modelcontextprotocol/sdk": "^1.0.0" }
};
```

After Tanmay finishes `/api/generate`, his route handler must also call `storage.set(id, ...)` so your `/api/code/[id]` can find it.

---

## What NOT to touch

- `prompts/curator.md` — Tanmay's prompt, the IP. Don't edit.
- `lib/curator.ts`, `lib/codegen.ts`, `lib/openapi.ts`, `lib/typecheck.ts`
- `templates/server.ts.tmpl`
- `/api/generate/route.ts` after Tanmay takes it over (delete your stub)

If you find a bug in any of those, ping Tanmay — don't patch it yourself. Your time is on UI/CLI/deploy.

---

## If you finish early

1. Add a "Try a sample spec" dropdown (Resend, OpenWeather, NASA APOD) for one-click demos
2. Add a `claude://` deeplink button that pre-fills Claude Desktop config (high-impact polish)
3. Add a syntax-highlighted code preview of the generated `index.ts`
4. Add a "Re-curate" button that re-runs `/api/generate` with a hint like "be more aggressive about merging"

---

## Emergency fallbacks

If `/api/generate` is broken at demo time:
- Your `/api/code/[id]` still works against pre-stored ids → demo a pre-baked one
- Have `id=resend-prebaked` and `id=openweather-prebaked` already in KV (Tanmay or you populate the night before)
- Demo path: skip the paste, talk over the side-by-side, show the install + Claude Desktop call

If `npx mcp-from-spec` is broken at demo time:
- Have the generated `index.ts` saved locally on the demo laptop
- `tsx /local/path/index.ts` works as a manual fallback for the live tool call

---

**Questions for Tanmay before you start:** none. Build against the contract.
