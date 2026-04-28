import type { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { fetchAndNormalize } from "@/lib/openapi";
import { curate, mechanicalToolList } from "@/lib/curator";
import { generateServer } from "@/lib/codegen";
import { storage } from "@/lib/storage";
import type { ToolMeta } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type GenerateRequest = {
  source: { kind: "url"; value: string } | { kind: "inline"; value: string };
  apiKeyEnv?: string;
  baseUrl?: string;
};

export async function POST(req: NextRequest) {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.source || !body.source.kind || !body.source.value) {
    return Response.json(
      { error: "Missing required field: source.{kind,value}" },
      { status: 400 },
    );
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );

      try {
        send("progress", { stage: "parsing" });
        const spec = await fetchAndNormalize(body.source, body.baseUrl, (_event, msg) => {
          // Surface discovery/redirect activity inside the existing parsing stage so the UI's
          // 4-step stepper doesn't have to learn new stage names.
          send("progress", { stage: "parsing", msg });
        });

        send("progress", {
          stage: "curating",
          msg: `${spec.ops.length} operations parsed`,
        });

        const mechanical: ToolMeta[] = mechanicalToolList(spec);

        let curated: ToolMeta[];
        try {
          curated = await curate(spec);
        } catch (curationErr) {
          send("progress", {
            stage: "curating",
            msg: `curation failed, using mechanical fallback: ${(curationErr as Error).message}`,
          });
          curated = mechanical;
        }

        send("progress", { stage: "generating", msg: `${curated.length} tools` });
        const apiKeyEnv = body.apiKeyEnv ?? "API_KEY";
        const code = await generateServer(spec, curated, apiKeyEnv);

        const id = nanoid(8);
        await storage.set(id, {
          code,
          deps: { "@modelcontextprotocol/sdk": "^1.0.0" },
          mechanical,
          curated,
          createdAt: Date.now(),
        });

        send("progress", { stage: "done" });
        send("result", { id, mechanical, curated, code });
      } catch (err) {
        send("error", { message: (err as Error).message ?? "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
