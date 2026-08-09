import { useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Link2,
  MapPin,
  Search,
  Loader2,
  Play,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Component A, the intake banner: trial URL, PDF drop target (drag/drop + browse),
 * client-side scrub notice, and the audit trigger.
 */
export default function IngestionPanel({
  trialUrl,
  onTrialUrlChange,
  location,
  onLocationChange,
  file,
  onFileSelected,
  onClearFile,
  onRun,
  loading,
  scrubbing,
  error,
  onDismissError,
  onLoadSample,
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  const busy = loading || scrubbing;

  function handleDragOver(event) {
    event.preventDefault();
    if (busy) return;
    setIsDragging(true);
  }

  function handleDragLeave(event) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    if (busy) return;
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped) onFileSelected(dropped);
  }

  function handleBrowse(event) {
    const picked = event.target.files?.[0];
    if (picked) onFileSelected(picked);
    // Allow re-selecting the same file immediately after clearing.
    event.target.value = "";
  }

  function openPicker() {
    if (busy) return;
    inputRef.current?.click();
  }

  return (
    <section className="panel relative overflow-hidden animate-rise-in">
      <div className="border-b border-rule/70 px-5 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="eyebrow text-ink-3">Patient Intake</h2>
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <ShieldCheck
              className="h-3.5 w-3.5 text-accent/80"
              strokeWidth={2.25}
            />
            <span>Scrubbed locally before transmission</span>
          </div>
        </div>
      </div>

      {/* Two columns of fields, then a rule, then the action.
       *
       * Was a three-column stretch grid with the button as its own track, which
       * produced the two faults visible in the screenshot: the dropzone was
       * `flex-1` inside a stretched row, so it grew to match the height of the
       * two stacked inputs beside it and sat mostly empty, and the button hung
       * off the bottom-right of that track with nothing to align to.
       *
       * `items-start` lets each column take its natural height, and the action
       * moves to a footer row where a form's submit belongs. */}
      <div className="grid gap-lg p-5 sm:p-6 lg:grid-cols-2 lg:items-start">
        {/* Search scope: a URL narrows to one trial, blank searches them all. */}
        <div className="flex flex-col justify-between gap-4">
          <label
            htmlFor="patient-location"
            className="eyebrow mb-2 block text-ink-3"
          >
            Search near <span className="normal-case">(optional)</span>
          </label>
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              id="patient-location"
              type="text"
              spellCheck="false"
              value={location}
              disabled={busy}
              onChange={(event) => onLocationChange(event.target.value)}
              placeholder="City, State"
              className="w-full rounded-lg border border-rule/80 bg-paper/70 py-3 pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-rule-strong focus:border-accent/60 focus:bg-paper disabled:opacity-60"
            />
          </div>

          <label
            htmlFor="trial-url"
            className="eyebrow mb-2 mt-3 block text-ink-3"
          >
            Specific trial{" "}
            <span className="normal-case text-ink-3">(optional)</span>
          </label>
          <div className="relative">
            <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              id="trial-url"
              type="url"
              inputMode="url"
              spellCheck="false"
              value={trialUrl}
              disabled={busy}
              onChange={(event) => onTrialUrlChange(event.target.value)}
              placeholder="NCT number or link"
              className="w-full rounded-lg border border-rule/80 bg-paper/70 py-3 pl-9 pr-3 font-mono text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-rule-strong focus:border-accent/60 focus:bg-paper disabled:opacity-60"
            />
          </div>
          {/* This field's EMPTINESS selects the product's main mode, and nothing
              said so. "Specific trial (optional)" reads like a filter you may
              skip, so pasting a link — the obvious thing to do with a box that
              wants a link — silently swaps a ranked search for a single-study
              audit. The button label changes too, but only after you have typed.
              State the consequence where the choice is made. */}
          <p className="mt-2 text-xs leading-snug text-ink-3">
            {trialUrl.trim()
              ? "One study will be audited against this record."
              : "Leave blank to search every recruiting trial and rank them."}
          </p>
        </div>

        {/* PDF dropzone */}
        <div className="flex flex-col">
          <span className="eyebrow mb-2 block text-ink-3">
            Patient record <span className="text-accent">(required)</span>
          </span>
          <div
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={openPicker}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPicker();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Upload patient medical history PDF"
            className={`relative flex min-h-[92px] flex-1 cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-left transition-colors ${
              isDragging
                ? "border-accent bg-accent/10"
                : file
                  ? "border-rule bg-paper/70 hover:border-rule-strong"
                  : "border-rule bg-paper/40 hover:border-rule-strong hover:bg-paper-2/60"
            } ${busy ? "cursor-wait" : ""}`}
          >
            {file ? (
              <>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-rule bg-paper-2">
                  <FileText className="h-4 w-4 text-accent" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {file.name}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-ink-3">
                    {formatSize(file.size)} · stays on this device
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClearFile();
                  }}
                  disabled={busy}
                  aria-label="Remove file"
                  className="rounded-md border border-rule p-1.5 text-ink-3 transition-colors hover:border-rule-strong hover:text-ink disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    isDragging
                      ? "border-accent/50 bg-accent/15"
                      : "border-rule bg-paper-2"
                  }`}
                >
                  <Upload
                    className={`h-4 w-4 ${isDragging ? "text-accent" : "text-ink-3"}`}
                    strokeWidth={2}
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-2">
                    {isDragging
                      ? "Release to stage the file"
                      : "Drop the PDF here"}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    or{" "}
                    <span className="text-accent underline underline-offset-2">
                      browse files
                    </span>{" "}
                    · stays on this device
                  </p>
                </div>
              </>
            )}

            {/* Real client-side work: pdf.js parse + Safe Harbor de-identification. */}
            {scrubbing && (
              <div className="enter-content absolute inset-0 z-10 flex items-center gap-3 rounded-lg border border-accent/30 bg-paper/95 px-4">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                <span className="text-sm font-medium text-accent">
                  Parsing in browser. Scrubbing names, SSNs, dates, and
                  addresses…
                </span>
              </div>
            )}

            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={handleBrowse}
            />
          </div>
        </div>

      </div>

      {/* The action row. Separated by a rule, right-aligned, so the panel reads
          top-to-bottom as inputs -> decision -> act. */}
      <div className="flex flex-wrap items-center justify-end gap-sm border-t border-rule px-5 py-4 sm:px-6">
        <div className="flex items-end">
          <button
            type="button"
            onClick={onRun}
            // Must be `busy`, not `loading`: during the local parse/scrub phase
            // `loading` is still false, so a second click would kick off a
            // concurrent pdf.js parse and race the first one.
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-transparent bg-accent px-5 py-3 text-sm font-semibold text-accent-ink shadow-lift transition-colors duration-fast ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 lg:w-auto"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {scrubbing
                  ? "Scrubbing…"
                  : trialUrl.trim()
                    ? "Auditing…"
                    : "Searching…"}
              </>
            ) : (
              <>
                {trialUrl.trim() ? (
                  <Play className="h-4 w-4 fill-current" strokeWidth={2} />
                ) : (
                  <Search className="h-4 w-4" strokeWidth={2.5} />
                )}
                {trialUrl.trim()
                  ? "Run compliance audit"
                  : "Find matching trials"}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="animate-fade-in border-t border-risk/25 bg-risk/[0.08] px-5 py-3.5 sm:px-6">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-risk"
              strokeWidth={2.25}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-risk">
                {error.title}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-risk/75">
                {error.detail}
              </p>
              {/* The sample-data fallback surfaces only here, when it is actually
 useful, instead of occupying the primary navigation. */}
              {error.offerSample && (
                <button
                  type="button"
                  onClick={onLoadSample}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-risk/30 bg-risk/10 px-2.5 py-1.5 text-sm font-medium text-risk transition-colors hover:border-risk/50 hover:bg-risk/20"
                >
                  <FileText className="h-3.5 w-3.5" strokeWidth={2} />
                  View a sample audit instead
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error"
              className="rounded-md p-1 text-risk/70 transition-colors hover:bg-risk/10 hover:text-risk"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
