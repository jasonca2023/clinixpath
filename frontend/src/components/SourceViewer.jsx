import { useEffect, useMemo, useRef } from "react";
import { FileSearch, X } from "lucide-react";
import { segmentsForQuote } from "../lib/highlight.js";
import { useDialog } from "../lib/dialog.js";

/**
 * Shows the exact sentence a verdict rests on, highlighted inside the source it
 * came from.
 *
 * This is the answer to "why should I believe that?". A clinician will not act on
 * an unexplained verdict, so every claim has to be traceable back to the document
 * it was drawn from, in one click, without leaving the screen.
 */
export default function SourceViewer({ open, title, source, quote, onClose }) {
  const dialogRef = useDialog(open, onClose);
  const markRef = useRef(null);

  const segments = useMemo(
    () => (source ? segmentsForQuote(source, quote) : []),
    [source, quote],
  );
  const located = segments.some((s) => s.match);

  useEffect(() => {
    if (!open) return undefined;
    dialogRef.current?.focus();
    // Bring the highlighted span into view rather than making the user hunt.
    const id = window.setTimeout(
      () =>
        markRef.current?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        }),
      60,
    );
    return () => window.clearTimeout(id);
  }, [open, quote, dialogRef]);

  if (!open) return null;

  return (
    <div
      className="enter-scrim fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Source evidence"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="enter-dialog dialog flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-3.5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10">
              <FileSearch className="h-4 w-4 text-accent" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-ink">
                {title}
              </h2>
              <p className="mt-0.5 text-sm text-ink-3">
                {located
                  ? "The highlighted sentence is what this verdict was based on."
                  : "This quote could not be located in the source. Treat the verdict with caution."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-rule p-1.5 text-ink-3 transition-colors hover:border-rule-strong hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!located && quote && (
          <div className="border-b border-hold/20 bg-hold/[0.07] px-5 py-2.5">
            <p className="font-mono text-xs leading-relaxed text-hold/85">
              Model quoted: “{quote}”
            </p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink-3">
            {segments.map((seg, i) =>
              seg.match ? (
                <mark
                  key={i}
                  ref={markRef}
                  className="rounded bg-accent/25 px-0.5 text-accent ring-1 ring-accent/40"
                >
                  {seg.text}
                </mark>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
