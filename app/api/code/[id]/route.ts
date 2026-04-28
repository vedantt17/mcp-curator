import { storage } from "@/lib/storage";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const stored = await storage.get(id);
  if (!stored) {
    return new Response("not found", { status: 404 });
  }

  return Response.json({
    code: stored.code,
    entrypoint: "index.ts",
    deps: stored.deps ?? { "@modelcontextprotocol/sdk": "^1.0.0" },
  });
}
