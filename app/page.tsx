"use client";
import { useState } from "react";
import type { ToolMeta } from "@/lib/types";
import s from "./page.module.css";

type Result = { id: string; mechanical: ToolMeta[]; curated: ToolMeta[]; code: string };

const STAGE_ORDER = ["parsing", "curating", "generating", "done"] as const;
type StageName = (typeof STAGE_ORDER)[number];

const SAMPLES = [
  {
    label: "Resend — Email API",
    value: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json",
  },
  {
    label: "Petstore — Demo REST API",
    value: "https://petstore3.swagger.io/api/v3/openapi.json",
  },
];

export default function Page() {
  const [specInput, setSpecInput] = useState(
    "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json"
  );
  const [apiKeyEnv, setApiKeyEnv] = useState("API_KEY");
  const [activeStage, setActiveStage] = useState<StageName | null>(null);
  const [stageMsg, setStageMsg] = useState("");
  const [completedStages, setCompletedStages] = useState<Set<StageName>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState<"cmd" | "cfg" | null>(null);

  async function generate() {
    setLoading(true);
    setActiveStage("parsing");
    setCompletedStages(new Set());
    setResult(null);
    setErr(null);
    setStageMsg("");

    const isUrl = /^https?:\/\//.test(specInput.trim());

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: isUrl
            ? { kind: "url", value: specInput.trim() }
            : { kind: "inline", value: specInput.trim() },
          apiKeyEnv,
        }),
      });

      if (!res.body) { setErr("No response stream received."); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";

        for (const e of events) {
          const eventName = e.split("\n").find(l => l.startsWith("event:"))?.slice(6).trim();
          const dataStr   = e.split("\n").find(l => l.startsWith("data:"))?.slice(5).trim();
          if (!eventName || !dataStr) continue;
          const data = JSON.parse(dataStr);

          if (eventName === "progress") {
            const st = data.stage as StageName;
            setActiveStage(st);
            setStageMsg(data.msg ?? "");
            setCompletedStages(prev => {
              const idx = STAGE_ORDER.indexOf(st);
              const next = new Set(prev);
              STAGE_ORDER.slice(0, idx).forEach(x => next.add(x));
              return next;
            });
          }
          if (eventName === "result") {
            setResult(data);
            setActiveStage("done");
            setCompletedStages(new Set(STAGE_ORDER));
          }
          if (eventName === "error") setErr(data.message);
        }
      }
    } catch (e) {
      setErr((e as Error).message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function copy(text: string, key: "cmd" | "cfg") {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const cfgJson = result
    ? JSON.stringify(
        {
          mcpServers: {
            server: {
              command: "npx",
              args: ["mcp-from-spec", result.id],
              env: { [apiKeyEnv]: "<paste-key-here>" },
            },
          },
        },
        null,
        2
      )
    : "";

  const reductionPct =
    result && result.mechanical.length > 0
      ? Math.round((1 - result.curated.length / result.mechanical.length) * 100)
      : 0;

  return (
    <div className={s.root}>
      <div className={`${s.orb} ${s.orb1}`} />
      <div className={`${s.orb} ${s.orb2}`} />
      <div className={`${s.orb} ${s.orb3}`} />

      <div className={s.container}>
        {/* ── Header ── */}
        <header className={s.header}>
          <div className={s.pill}>
            <span className={s.pillDot} />
            Powered by Claude
          </div>
          <h1 className={s.title}>
            <span className={s.titleLine1}>API to MCP.</span>
            <span className={s.titleLine2}>In seconds.</span>
          </h1>
          <p className={s.subtitle}>
            Paste any OpenAPI spec. Claude curates a lean, typed MCP server — deployed with one command.
          </p>
        </header>

        {/* ── Input card ── */}
        <div className={s.card}>
          <div className={s.sectionLabel}>OpenAPI Specification</div>
          <textarea
            className={s.textarea}
            value={specInput}
            onChange={e => setSpecInput(e.target.value)}
            rows={4}
            placeholder="Paste a URL (https://...) or raw JSON / YAML spec"
            spellCheck={false}
          />
          <div className={s.inputRow}>
            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>API key env var</label>
              <input
                className={s.textInput}
                value={apiKeyEnv}
                onChange={e => setApiKeyEnv(e.target.value)}
                placeholder="API_KEY"
              />
            </div>
            <div className={s.fieldGroup}>
              <label className={s.fieldLabel}>Sample specs</label>
              <select
                className={s.select}
                defaultValue=""
                onChange={e => e.target.value && setSpecInput(e.target.value)}
              >
                <option value="" disabled>Choose a sample…</option>
                {SAMPLES.map(sample => (
                  <option key={sample.value} value={sample.value}>{sample.label}</option>
                ))}
              </select>
            </div>
            <button
              className={s.btnGenerate}
              onClick={generate}
              disabled={loading}
            >
              {loading ? <span className={s.spinner} /> : "⚡"}
              {loading ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>

        {/* ── Progress ── */}
        {activeStage && (
          <div className={`${s.card} ${s.progressCard}`}>
            <div className={s.stageTrack}>
              {STAGE_ORDER.map((st, i) => {
                const isDone   = completedStages.has(st);
                const isActive = activeStage === st;
                return (
                  <div key={st} className={s.stageItem}>
                    <div className={`${s.stageDot} ${isDone ? s.stageDotDone : isActive ? s.stageDotActive : s.stageDotPending}`}>
                      {isDone ? "✓" : i + 1}
                    </div>
                    <span className={`${s.stageLabel} ${isDone ? s.stageLabelDone : isActive ? s.stageLabelActive : ""}`}>
                      {st}
                    </span>
                    {i < STAGE_ORDER.length - 1 && (
                      <div className={`${s.stageLine} ${isDone ? s.stageLineFilled : ""}`} />
                    )}
                  </div>
                );
              })}
            </div>
            {stageMsg && <p className={s.stageMsg}>{stageMsg}</p>}
          </div>
        )}

        {/* ── Error ── */}
        {err && (
          <div className={`${s.card} ${s.errorCard}`}>
            <span>⚠</span> {err}
          </div>
        )}

        {/* ── Results ── */}
        {result && (
          <>
            {/* Metrics strip */}
            <div className={s.metricsStrip}>
              <div className={s.metric}>
                <span className={s.metricValue}>{result.mechanical.length}</span>
                <span className={s.metricLabel}>raw ops</span>
              </div>
              <span className={s.metricArrow}>→</span>
              <div className={s.metric}>
                <span className={`${s.metricValue} ${s.metricValuePurple}`}>{result.curated.length}</span>
                <span className={s.metricLabel}>curated tools</span>
              </div>
              <div className={s.metricDivider} />
              <span className={`${s.badge} ${s.badgeGold}`}>{reductionPct}% leaner</span>
              <span className={`${s.badge} ${s.badgeGreen}`}>TypeScript</span>
              <span className={`${s.badge} ${s.badgePurple}`}>MCP ready</span>
              <span className={`${s.badge} ${s.badgeCyan}`}>id: {result.id}</span>
            </div>

            {/* Side-by-side */}
            <div className={s.compareGrid}>
              <ToolPane
                title="Raw Mechanical"
                count={result.mechanical.length}
                tools={result.mechanical}
                dim
              />
              <ToolPane
                title="Claude Curated"
                count={result.curated.length}
                tools={result.curated}
                highlight
              />
            </div>

            {/* Install */}
            <div className={s.installSection}>
              <div className={s.installBlock}>
                <div className={s.installBlockLabel}>Install command</div>
                <div className={s.codeRow}>
                  <code className={s.codeChip}>npx mcp-from-spec {result.id}</code>
                  <button
                    className={`${s.copyBtn} ${copied === "cmd" ? s.copyBtnDone : ""}`}
                    onClick={() => copy(`npx mcp-from-spec ${result.id}`, "cmd")}
                  >
                    {copied === "cmd" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className={s.installBlock}>
                <div className={s.installBlockLabel}>Claude Desktop config</div>
                <div className={s.codeRow}>
                  <code className={s.codeChip}>claude_desktop_config.json</code>
                  <button
                    className={`${s.copyBtn} ${copied === "cfg" ? s.copyBtnDone : ""}`}
                    onClick={() => copy(cfgJson, "cfg")}
                  >
                    {copied === "cfg" ? "✓ Copied" : "Copy config"}
                  </button>
                </div>
                <pre className={s.configPre}>{cfgJson}</pre>
              </div>
            </div>

            {/* Code preview */}
            <button className={s.codeToggle} onClick={() => setShowCode(v => !v)}>
              {showCode ? "▲" : "▼"} {showCode ? "Hide generated TypeScript" : "View generated TypeScript"}
            </button>
            {showCode && <pre className={`${s.card} ${s.codePre}`}>{result.code}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function ToolPane({
  title, count, tools, dim, highlight,
}: {
  title: string; count: number; tools: ToolMeta[]; dim?: boolean; highlight?: boolean;
}) {
  return (
    <div className={`${s.pane} ${dim ? s.paneDim : ""} ${highlight ? s.paneHighlight : ""}`}>
      <div className={s.paneHeader}>
        <span className={`${s.paneTitle} ${highlight ? s.paneTitleHighlight : ""}`}>{title}</span>
        <span className={`${s.paneCount} ${highlight ? s.paneCountHighlight : ""}`}>{count} tools</span>
      </div>
      <div className={s.toolList}>
        {tools.map(t => (
          <details key={t.name} className={s.toolCard}>
            <summary className={s.toolSummary}>
              <div className={s.toolNameRow}>
                <span className={s.toolName}>{t.name}</span>
                {t.composes.length > 1 && (
                  <span className={s.toolMergedBadge}>+{t.composes.length - 1} merged</span>
                )}
              </div>
              <span className={s.toolChevron}>▼</span>
            </summary>
            <div className={s.toolBody}>
              <p className={s.toolDesc}>{t.description}</p>
              {t.examples?.[0] && (
                <pre className={s.toolExample}>
                  {JSON.stringify(t.examples[0].args, null, 2)}
                </pre>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
