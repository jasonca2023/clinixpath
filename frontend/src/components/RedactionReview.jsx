import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Eye,
  FileLock2,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useDialog } from "../lib/dialog.js";

/**
 * The review gate.
 *
 * Nothing reaches the network until a human has read this screen and pressed send.
 * The textarea is editable on purpose: automated scrubbing misses indirect
 * identifiers (narrative names, rare diagnoses, institutions), so the clinician gets
 * the last word on what leaves the device.
 */
export default function RedactionReview({
  open,
  originalText,
  redactedText,
  counts,
  total,
  onCancel,
  onConfirm,
}) {
  const [edited, setEdited] = useState(redactedText ?? "");
  const [showOriginal, setShowOriginal] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // Escape, focus trap, scroll lock, focus restore. The trap matters most here:
  // the control behind this scrim is the one that sends patient text off-device.
  const dialogRef = useDialog(open, onCancel);

  // Reset on every OPEN, not on a change of text. Keying this to `redactedText`
  // alone meant reviewing the same record twice skipped the reset entirely — React
  // compares the string by value, so an identical scrub is not a change — and the
  // dialog reopened holding the previous session's edits, the acknowledgement
  // still ticked, while presenting itself as what the scrubber just produced. A
  // review gate that silently shows stale text is not a review gate.
  useEffect(() => {
    if (!open) return;
    setEdited(redactedText ?? "");
    setShowOriginal(false);
    setAcknowledged(false);
  }, [open, redactedText]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, dialogRef]);

  const found = useMemo(
    () => Object.entries(counts ?? {}).filter(([, n]) => n > 0),
    [counts],
  );

  if (!open) return null;

  return (
    <div
      className="enter-scrim fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Review de-identified text before sending"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="enter-dialog dialog flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden outline-none"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10">
              <FileLock2
                className="h-[18px] w-[18px] text-accent"
                strokeWidth={2}
              />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-ink">
                Review before sending
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-3">
                The PDF was parsed in your browser and never uploaded. Only the
                text below will be transmitted.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-md border border-rule p-1.5 text-ink-3 transition-colors hover:border-rule-strong hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Redaction summary */}
        <div className="border-b border-rule px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow mr-1">
              {total} redaction{total === 1 ? "" : "s"}
            </span>
            {found.length === 0 ? (
              <span className="rounded border border-hold/40 bg-hold/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-hold">
                nothing matched: review carefully
              </span>
            ) : (
              found.map(([category, n]) => (
                <span
                  key={category}
                  className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-xs tracking-wide text-accent"
                >
                  {category} × {n}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Honest limitation notice */}
        <div className="flex items-start gap-2.5 border-b border-hold/20 bg-hold/[0.06] px-5 py-3">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-hold"
            strokeWidth={2.25}
          />
          <p className="text-sm leading-relaxed text-hold/85">
            Automated scrubbing catches direct identifiers. It can miss names in
            narrative text, rare diagnoses, institution names, and other
            indirect identifiers.{" "}
            <strong className="font-semibold">Read the text below</strong> and
            edit anything that could identify the patient.
          </p>
        </div>

        {/* Text */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">
              {showOriginal
                ? "Original (never transmitted)"
                : "Will be transmitted"}
            </span>
            <button
              type="button"
              onClick={() => setShowOriginal((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule px-2 py-1 text-xs text-ink-2 transition-colors hover:border-rule-strong hover:text-ink"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={2} />
              {showOriginal ? "Show redacted" : "Compare with original"}
            </button>
          </div>

          {showOriginal ? (
            <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap rounded-lg border border-risk/30 bg-risk/[0.05] p-3 font-mono text-sm leading-relaxed text-risk/80">
              {originalText}
            </pre>
          ) : (
            <textarea
              value={edited}
              onChange={(event) => setEdited(event.target.value)}
              spellCheck={false}
              className="h-[38vh] w-full resize-none rounded-lg border border-rule bg-paper p-3 font-mono text-sm leading-relaxed text-ink-2 outline-none focus:border-accent/50"
            />
          )}
        </div>

        {/* Confirm */}
        <div className="border-t border-rule px-5 py-4">
          <label className="mb-3 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="text-sm leading-relaxed text-ink-2">
              I have reviewed this text and confirm it contains no information
              that could identify the patient.
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-rule px-4 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:border-rule-strong hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!acknowledged || !edited.trim()}
              onClick={() => onConfirm(edited.trim())}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink shadow-lift transition-colors duration-fast ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              <Send className="h-4 w-4" strokeWidth={2.25} />
              Send de-identified text
            </button>
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
            <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={2} />
            The original file stays on this device. Only the text above is sent.
          </p>
        </div>
      </div>
    </div>
  );
}
