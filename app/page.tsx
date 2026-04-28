"use client";
import { useState } from "react";
import type { ToolMeta } from "@/lib/types";
import s from "./page.module.css";

type Result = { id: string; mechanical: ToolMeta[]; curated: ToolMeta[]; code: string };

const STAGE_ORDER = ["parsing", "curating", "generating", "done"] as const;
type StageName = (typeof STAGE_ORDER)[number];

const SAMPLES = [
  { label: "Resend — Email API", value: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.json" },
  { label: "Petstore — Demo REST API", value: "https://petstore3.swagger.io/api/v3/openapi.json" },
];

/* ── Inline SVG icons (no emoji, no external deps) ─────────────────── */
function IconArrowRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2.5 6.5h8m0 0L7 3m3.5 3.5L7 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M1.5 5.5l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconChevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconWarning() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M7.5 1L14 13H1L7.5 1z" stroke="#be123c" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7.5 6v3M7.5 10.5v.5" stroke="#be123c" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function IconCopy() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="3.5" y="3.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 7.5H1.5a1 1 0 01-1-1V1.5a1 1 0 011-1H6.5a1 1 0 011 1V2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconCode() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4 2L1 6l3 4M8 2l3 4-3 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
      if (!res.body) { setErr("No response stream."); return; }
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
    ? JSON.stringify({ mcpServers: { server: { command: "npx", args: ["mcp-from-spec", result.id], env: { [apiKeyEnv]: "<paste-key-here>" } } } }, null, 2)
    : "";

  const reductionPct =
    result && result.mechanical.length > 0
      ? Math.round((1 - result.curated.length / result.mechanical.length) * 100)
      : 0;

  return (
    <div className={s.root}>
      {/* ── Nav ── */}
      <nav className={s.nav}>
        <div className={s.navLogo}>
          <div className={s.navLogoMark}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="1" fill="white" />
              <rect x="8" y="1" width="5" height="5" rx="1" fill="white" fillOpacity="0.5" />
              <rect x="1" y="8" width="5" height="5" rx="1" fill="white" fillOpacity="0.5" />
              <rect x="8" y="8" width="5" height="5" rx="1" fill="#34d399" />
            </svg>
          </div>
          <span className={s.navWordmark}>MCP Curator</span>
        </div>
        <div className={s.navBadge}>
          <span className={s.navBadgeDot} />
          Powered by Claude
        </div>
      </nav>

      <div className={s.container}>
        {/* ── Hero (left-aligned) ── */}
        <header className={s.hero}>
          <div className={s.heroEyebrow}>
            <span className={s.heroEyebrowLine} />
            OpenAPI to MCP
          </div>
          <h1 className={s.heroTitle}>
            Your API,<br />
            <span className={s.heroAccent}>Claude-ready.</span>
          </h1>
          <p className={s.heroSub}>
            Paste any OpenAPI spec. Get a curated, lean MCP server with rewritten tool descriptions — installable with one command.
          </p>
        </header>

        {/* ── Input card ── */}
        <div className={s.card}>
          <label className={s.fieldLabel}>OpenAPI Specification</label>
          <textarea
            className={s.textarea}
            value={specInput}
            onChange={e => setSpecInput(e.target.value)}
            rows={4}
            placeholder="Paste a URL (https://...) or raw JSON / YAML"
            spellCheck={false}
          />
          <div className={s.inputRow}>
            <div className={s.inputGroup}>
              <label className={s.fieldLabel}>API key env var</label>
              <input
                className={s.textInput}
                value={apiKeyEnv}
                onChange={e => setApiKeyEnv(e.target.value)}
                placeholder="API_KEY"
              />
            </div>
            <div className={s.inputGroup}>
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
            <button className={s.btnGenerate} onClick={generate} disabled={loading}>
              {loading ? <span className={s.spinner} /> : <span className={s.btnAccent} />}
              {loading ? "Generating…" : "Generate"}
              {!loading && <IconArrowRight />}
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
                      {isDone ? <IconCheck /> : i + 1}
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
            <IconWarning /> {err}
          </div>
        )}

        {/* ── Results ── */}
        {result && (
          <>
            {/* Metrics */}
            <div className={s.metricsStrip}>
              <div className={s.metricCell}>
                <span className={s.metricVal}>{result.mechanical.length}</span>
                <span className={s.metricKey}>Raw operations</span>
              </div>
              <div className={s.metricCell}>
                <span className={`${s.metricVal} ${s.metricValGreen}`}>{result.curated.length}</span>
                <span className={s.metricKey}>Curated tools</span>
              </div>
              <div className={s.metricCell}>
                <span className={`${s.metricVal} ${s.metricValGreen}`}>{reductionPct}%</span>
                <span className={s.metricKey}>Leaner</span>
              </div>
              <div className={s.metricCell}>
                <span className={`${s.metricTag} ${s.metricTagGreen}`}>MCP ready</span>
              </div>
              <div className={s.metricCell}>
                <span className={`${s.metricTag} ${s.metricTagZinc}`}>TypeScript</span>
              </div>
            </div>

            {/* Side-by-side */}
            <div className={s.compareGrid}>
              <ToolPane title="Raw Mechanical" count={result.mechanical.length} tools={result.mechanical} dim />
              <ToolPane title="Claude Curated" count={result.curated.length} tools={result.curated} highlight />
            </div>

            {/* Install */}
            <div className={s.installSection}>
              <div className={s.installBlock}>
                <div className={s.installLabel}>Install command</div>
                <div className={s.codeRow}>
                  <code className={s.codeChip}>npx mcp-from-spec {result.id}</code>
                  <button
                    className={`${s.copyBtn} ${copied === "cmd" ? s.copyBtnDone : ""}`}
                    onClick={() => copy(`npx mcp-from-spec ${result.id}`, "cmd")}
                  >
                    {copied === "cmd" ? <IconCheck /> : <IconCopy />}
                    {copied === "cmd" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className={s.installBlock}>
                <div className={s.installLabel}>Claude Desktop config</div>
                <div className={s.codeRow}>
                  <code className={s.codeChip}>claude_desktop_config.json</code>
                  <button
                    className={`${s.copyBtn} ${copied === "cfg" ? s.copyBtnDone : ""}`}
                    onClick={() => copy(cfgJson, "cfg")}
                  >
                    {copied === "cfg" ? <IconCheck /> : <IconCopy />}
                    {copied === "cfg" ? "Copied" : "Copy config"}
                  </button>
                </div>
                <pre className={s.configPre}>{cfgJson}</pre>
              </div>
            </div>

            {/* Code preview */}
            <button className={s.codeToggle} onClick={() => setShowCode(v => !v)}>
              <IconCode />
              {showCode ? "Hide generated TypeScript" : "View generated TypeScript"}
              <span style={{ marginLeft: "auto", opacity: 0.4 }}>{showCode ? "▲" : "▼"}</span>
            </button>
            {showCode && <pre className={`${s.card} ${s.codePre}`}>{result.code}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function ToolPane({ title, count, tools, dim, highlight }: {
  title: string; count: number; tools: ToolMeta[]; dim?: boolean; highlight?: boolean;
}) {
  return (
    <div className={`${s.pane} ${dim ? s.paneDim : ""} ${highlight ? s.paneHighlight : ""}`}>
      <div className={s.paneHeader}>
        <span className={`${s.paneTitle} ${highlight ? s.paneTitleGreen : ""}`}>{title}</span>
        <span className={`${s.paneCount} ${highlight ? s.paneCountGreen : ""}`}>{count} tools</span>
      </div>
      <div className={s.toolList}>
        {tools.map(t => (
          <details key={t.name} className={s.toolCard}>
            <summary className={s.toolSummary}>
              <div className={s.toolNameRow}>
                <span className={s.toolName}>{t.name}</span>
                {t.composes.length > 1 && (
                  <span className={s.toolMergedTag}>+{t.composes.length - 1} merged</span>
                )}
              </div>
              <span className={s.toolChevron}><IconChevron /></span>
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
