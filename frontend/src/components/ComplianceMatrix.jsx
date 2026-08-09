import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileText,
  HelpCircle,
  Microscope,
  Quote,
  Stethoscope,
} from "lucide-react";
import { categoryStyle, categoryLabel } from "./PatientChecklist.jsx";

// PRD section 6 specifies light-mode status classes (bg-ok/40, text-ok,
// etc.). This console runs on a dark shell, so the PRD's color *intent* is carried
// over at dark-appropriate opacity: green-500 / red-500 / gray-400 borders with
// low-alpha fills. Badge copy, layout, and animation follow the PRD verbatim.
export const STATUS_STYLES = {
  MATCH: {
    badge: "Met",
    icon: CheckCircle2,
    card: "border-ok/45",
    badgeClass: "border-ok/40 bg-ok/15 text-ok",
    iconColor: "text-ok",
    divider: "border-ok/20",
    explain: "border-rule bg-paper-2/60 text-ink-2",
    animated: false,
  },
  CONFLICT: {
    badge: "Blocked",
    icon: AlertTriangle,
    card: "border-risk/50",
    badgeClass: "border-risk/50 bg-risk/20 text-risk",
    iconColor: "text-risk",
    divider: "border-risk/20",
    explain: "border-rule bg-paper-2/60 text-ink-2",
    animated: true,
  },
  UNKNOWN: {
    badge: "Data gap",
    icon: HelpCircle,
    card: "border-gap/45",
    badgeClass: "border-gap/60 bg-gap/35 text-gap",
    iconColor: "text-gap",
    divider: "border-gap/25",
    explain: "border-rule bg-paper-2/60 text-ink-2",
    animated: false,
  },
};

function statusStyle(status) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.UNKNOWN;
}

function SummaryStrip({ rows }) {
  const counts = useMemo(() => {
    const tally = { MATCH: 0, CONFLICT: 0, UNKNOWN: 0 };
    rows.forEach((row) => {
      const key = STATUS_STYLES[row?.status] ? row.status : "UNKNOWN";
      tally[key] += 1;
    });
    return tally;
  }, [rows]);

  const tiles = [
    { key: "MATCH", label: "Met", value: counts.MATCH, tone: "text-ok" },
    {
      key: "CONFLICT",
      label: "Blocked",
      value: counts.CONFLICT,
      tone: "text-risk",
    },
    {
      key: "UNKNOWN",
      label: "Data gap",
      value: counts.UNKNOWN,
      tone: "text-gap",
    },
  ];

  const blocking = counts.CONFLICT > 0;

  return (
    <div className="panel flex flex-wrap items-center gap-x-2 gap-y-3 px-4 py-3 sm:gap-x-3">
      <div className="grid flex-1 grid-cols-3 gap-2 sm:gap-3">
        {tiles.map((tile) => {
          const style = statusStyle(tile.key);
          const Icon = style.icon;
          return (
            <div
              key={tile.key}
              className="flex items-center gap-2.5 rounded-lg border border-rule/70 bg-paper/50 px-3 py-2"
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${style.iconColor}`}
                strokeWidth={2.25}
              />
              <div className="min-w-0">
                <div
                  className={`font-mono text-lg font-semibold leading-none ${tile.tone}`}
                >
                  {String(tile.value).padStart(2, "0")}
                </div>
                <div className="eyebrow mt-1 truncate">{tile.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
          blocking
            ? "border-risk/35 bg-risk/10 text-risk"
            : "border-ok/30 bg-ok/10 text-ok"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${blocking ? "bg-risk" : "bg-ok"}`}
        />
        {blocking ? "Enrollment blocked" : "No blocking conflicts"}
      </div>
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div className="space-y-3">
      <div className="panel px-4 py-3">
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((tile) => (
            <div key={tile} className="skeleton h-[46px]" />
          ))}
        </div>
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="panel overflow-hidden p-4">
          <div className="flex items-center justify-between">
            <div className="skeleton h-3.5 w-32" />
            <div className="skeleton h-5 w-28" />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <div className="skeleton h-3 w-20" />
              <div className="skeleton mt-2.5 h-4 w-full" />
              <div className="skeleton mt-2 h-4 w-3/5" />
            </div>
            <div>
              <div className="skeleton h-3 w-24" />
              <div className="skeleton mt-2.5 h-4 w-full" />
              <div className="skeleton mt-2 h-14 w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <p className="max-w-[62ch] py-md text-sm leading-relaxed text-ink-3">
      No audit has been run. Drop a patient record above and search — every
      recruiting trial is matched criterion by criterion, ranked by how close the
      patient is to enrolling.
    </p>
  );
}

/**
 * True when the model's paraphrase and its verbatim quote are effectively the same
 * sentence. When they are, rendering both just prints the same text twice, so the
 * quote collapses into a "verify" affordance on the paraphrase itself.
 */
function sameText(a, b) {
  const norm = (t) =>
    (t || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * A quoted sentence. A button when there is a source to open, a plain block when
 * there is not — same ink either way, so the row reads identically.
 */
function Quoted({ interactive, onClick, className, title, children }) {
  if (!interactive) {
    return <div className={className}>{children}</div>;
  }
  return (
    <button type="button" onClick={onClick} className={className} title={title}>
      {children}
    </button>
  );
}

export function MatrixRow({ row, index, onShowSource }) {
  // The landing page renders this component to show what the tool returns, but
  // has no source documents to open. Without a handler the quote must not be a
  // button: a focusable control with a tooltip promising to show you something,
  // that does nothing when pressed, is worse than plain text.
  const canOpenSource = typeof onShowSource === "function";
  const style = statusStyle(row?.status);
  const StatusIcon = style.icon;
  const category = categoryStyle(row?.category);
  const CategoryIcon = category.icon;

  return (
    <article
      className={`relative animate-rise-in overflow-hidden rounded-lg border ${style.card} shadow-lift transition-colors duration-mid ease-out`}
    >
      {/* Row header */}
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b ${style.divider} px-4 py-2.5`}
      >
        <span className="font-mono text-xs text-ink-3">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-xs uppercase tracking-[0.12em] ${category.chip}`}
        >
          <CategoryIcon className="h-3 w-3" strokeWidth={2.25} />
          {categoryLabel(row?.category)}
        </span>

        <span
          className={`ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs font-bold uppercase tracking-[0.1em] ${style.badgeClass} ${
            style.animated ? "animate-pulse-attention" : ""
          }`}
        >
          <StatusIcon className="h-3.5 w-3.5" strokeWidth={2.5} />
          {style.badge}
        </span>
      </div>

      {/* Two halves */}
      <div className="grid gap-px bg-paper-3/40 md:grid-cols-2">
        {/* Left: patient fact */}
        <div className="bg-paper-2/60 px-4 py-4">
          <div className="mb-2 flex items-center gap-1.5">
            <Stethoscope className="h-3.5 w-3.5 text-ink-3" strokeWidth={2} />
            <span className="eyebrow">From the record</span>
          </div>
          <p className="text-sm leading-relaxed text-ink">
            {row?.patient_fact ?? "Not extracted from the record."}
          </p>
          {row?.record_quote ? (
            <Quoted
              interactive={canOpenSource}
              onClick={() => onShowSource?.("record", row)}
              className={`mt-2.5 flex w-full items-start gap-1.5 rounded-md border border-rule bg-paper/60 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.06] ${
                sameText(row.patient_fact, row.record_quote)
                  ? "px-2.5 py-1.5"
                  : "px-2.5 py-2"
              }`}
              title="Show this sentence in the record"
            >
              <Quote
                className="mt-0.5 h-3 w-3 shrink-0 text-ink-3"
                strokeWidth={2}
              />
              <span className="font-mono text-xs leading-relaxed text-ink-3">
                {sameText(row.patient_fact, row.record_quote)
                  ? "Verify in record"
                  : row.record_quote}
              </span>
            </Quoted>
          ) : (
            <p className="mt-2.5 font-mono text-xs text-ink-3">
              {row?.patient_fact
                ? "No source sentence captured for this fact."
                : "Nothing in the record speaks to this criterion."}
            </p>
          )}

          {row?.status === "UNKNOWN" && row?.data_needed && (
            <div className="mt-3 rounded-lg border border-hold/30 bg-hold/[0.07] px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <ClipboardList
                  className="h-3 w-3 text-hold"
                  strokeWidth={2.25}
                />
                <span className="font-mono text-xs uppercase tracking-[0.16em] text-hold/90">
                  To obtain
                </span>
              </div>
              <p className="text-sm font-medium leading-relaxed text-hold/90">
                {row.data_needed}
              </p>
            </div>
          )}
        </div>

        {/* Right: trial criteria + explanation */}
        <div className="bg-paper-2/30 px-4 py-4">
          <div className="mb-2 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-ink-3" strokeWidth={2} />
            <span className="eyebrow">From the protocol</span>
          </div>
          <p className="text-sm leading-relaxed text-ink-2">
            {row?.trial_rule ?? "No matching rule found in the protocol."}
          </p>
          {row?.criterion_quote && (
            <Quoted
              interactive={canOpenSource}
              onClick={() => onShowSource?.("criteria", row)}
              className={`mt-2.5 flex w-full items-start gap-1.5 rounded-md border border-rule bg-paper/60 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.06] ${
                sameText(row.trial_rule, row.criterion_quote)
                  ? "px-2.5 py-1.5"
                  : "px-2.5 py-2"
              }`}
              title="Show this criterion in the protocol"
            >
              <Quote
                className="mt-0.5 h-3 w-3 shrink-0 text-ink-3"
                strokeWidth={2}
              />
              <span className="font-mono text-xs leading-relaxed text-ink-3">
                {sameText(row.trial_rule, row.criterion_quote)
                  ? "Verify in protocol"
                  : row.criterion_quote}
              </span>
            </Quoted>
          )}

          <div
            className={`mt-3 rounded-lg border px-3 py-2.5 ${style.explain}`}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Microscope className="h-3 w-3 opacity-80" strokeWidth={2.25} />
              <span className="font-mono text-xs uppercase tracking-[0.16em] opacity-80">
                Why this verdict
              </span>
            </div>
            <p className="text-sm leading-relaxed">
              {row?.explanation ??
                "No explanation was returned for this criterion."}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Component C: the compliance matrix plus its summary strip. */
export default function ComplianceMatrix({ items, loading, onShowSource }) {
  const rows = Array.isArray(items) ? items : [];

  if (loading) return <MatrixSkeleton />;
  if (rows.length === 0) return <EmptyState />;

  return (
    <div className="space-y-3">
      <SummaryStrip rows={rows} />
      <div className="space-y-3">
        {rows.map((row, index) => (
          <MatrixRow
            key={row?.id ?? `row-${index}`}
            row={row}
            index={index}
            onShowSource={onShowSource}
          />
        ))}
      </div>
    </div>
  );
}
