# MCP Curator

Paste an OpenAPI spec → Claude curates it into an LLM-optimized MCP tool set → install with one `npx` command.

Mechanical OpenAPI→MCP converters give you 200 confusing tools. This uses Claude to pick the ≤12 most useful endpoints, drop destructive operations, merge related reads, and rewrite descriptions for LLM consumption.

## Repo layout

```
mcp-curator/
├── docs/superpowers/specs/   # design spec
├── prompts/                  # Claude curator system prompt + worked examples
├── templates/                # MCP server template
└── lib/                      # spec parser, curator, codegen
```

## Status

Pre-event prep. AI side ~80% complete. Web UI, CLI package, and deploy are still to do — see `PERSON-B-TASKS.md`.

## Architecture

```
[Web UI] → POST /api/generate (SSE) → Claude curation → mechanical codegen → KV store
                                                                                  ↓
[Claude Desktop] → npx mcp-from-spec <id> → GET /api/code/<id> → spawn tsx → MCP server (stdio)
```

See `docs/superpowers/specs/2026-04-27-mcp-curator-design.md` for the full design.
