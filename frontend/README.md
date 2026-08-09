# ClinixPath: Frontend

Clinical trial eligibility console. Drop a patient's medical history PDF, paste a
clinical trial URL, and get a criterion-by-criterion compliance matrix.

Built with Vite + React 18 + Tailwind CSS v3 + lucide-react.

## Getting started

```bash
npm install
npm run dev
```

The dev server prints a local URL (default http://localhost:5173).

Other scripts:

```bash
npm run build     # production build to dist/
npm run preview   # serve the production build locally
```

## Backend

The backend lives in `../backend`. The two apps stay in separate trees, but they are
wired: this frontend posts `multipart/form-data` with `trial_url`, `patient_text`
(de-identified, **the PDF itself is never uploaded**) and `session_id` to:

```
POST http://localhost:8000/api/analyze
```

The base URL is a single constant at the top of `src/App.jsx`:

```js
const API_BASE_URL = 'http://localhost:8000';
```

Change that one line to point at a different host. If the request fails, the UI
shows an inline error banner and directs the user to Presentation Mode.

The request posts `trial_url`, `patient_text`, and a hardcoded `session_id` of
`demo-user` (PRD section 1: no auth, single active session). There is no `file`
field; the PDF is parsed locally and never uploaded.

Expected response shape:

```json
{
  "patient_summary": [
    { "category": "GENETICS", "metric_name": "...", "extracted_value": "..." }
  ],
  "compliance_matrix": [
    {
      "id": "node_1",
      "category": "GENETICS",
      "patient_fact": "...",
      "trial_rule": "...",
      "status": "MATCH | CONFLICT | UNKNOWN",
      "explanation": "..."
    }
  ]
}
```

Supported `patient_summary` categories (each has its own color): `GENETICS`,
`LAB_VALUES`, `DEMOGRAPHICS`, `COMORBIDITIES`, `MEDICATIONS`. Anything else falls
back to a neutral slate style, so new categories will not break the UI.

## Presentation mode

The header has a **Load Presentation Mode** toggle. It instantly populates the
dashboard from `src/mockData.js` (the PRD section 7 fail-safe dataset) with no
network call, so the app demos perfectly with the backend offline. Click it again
to exit.

Useful as a stage fallback if the network or the backend is unavailable.

## Privacy note

The privacy pipeline is **real**, not simulated:

1. `src/lib/pdfText.js` parses the PDF with pdf.js **in the browser**. The file is
   never uploaded: no multipart file field exists on the request anymore.
2. `src/lib/deidentify.js` strips HIPAA Safe Harbor identifiers (SSN, MRN, phone,
   email, URL/IP, dates → year only, addresses/ZIP, labeled and titled names) and
   aggregates ages over 89. Clinical values, units, gene notation and staging are
   explicitly protected so scrubbing cannot eat `1,200 cells/µL` or `EGFR Exon 19`.
3. `src/components/RedactionReview.jsx` **blocks transmission** until a human reads
   the redacted text, optionally edits it, and ticks the confirmation box.
4. Only the approved string is POSTed, as `patient_text`.

### What the scrubber does NOT catch: measured, not estimated

The scrubber matches identifiers that have *structure*. It does not understand
language, so anything that looks like ordinary English passes through. Tested
against 11 Safe Harbor cases, **10 were not redacted**:

| Input | Result |
| --- | --- |
| `...his wife Susan at bedside.` | passed through |
| `Care coordinated by Karen Ellsworth, oncology navigator.` | passed through |
| `Transferred from St. Aloysius Medical Center` | passed through |
| `NORTHSIDE ONCOLOGY ASSOCIATES` (letterhead) | passed through |
| `Patient resides in Cleveland` | passed through |
| `Works as a machinist at Voss Precision Tooling.` | passed through |
| `The patient is 94 and remains highly functional.` | passed through |
| `Admitted the week of Thanksgiving 2025` | passed through |
| `Reviewed by M.T.H. per protocol.` | passed through |
| `One of two known cases of NUT carcinoma in the county registry.` | passed through |
| `The patient is a 94-year-old female.` | **redacted** → `90 or older` |

Bare first names, surnames without a title, facility names, cities, employers and
quasi-identifiers all survive. Regex cannot tell `Susan` (a person) from
`Sunitinib` (a drug); that needs a model, not more patterns.

**Consequence: this does not meet HIPAA Safe Harbor**, which requires all 18
identifier categories removed. Do not run real patient records through it on the
strength of the scrubbing alone. The review gate exists precisely because the
automation is known-incomplete; a human reading the payload is the actual control.

### Where this is and isn't usable

- **Synthetic/demo data**: fine as-is. HIPAA doesn't apply to fabricated records.
- **A patient uploading their own record**: HIPAA doesn't regulate individuals
  handling their own health data. Other law still applies (FTC Act on deceptive
  privacy claims, the FTC Health Breach Notification Rule, and state consumer
  health-data laws such as Washington's My Health My Data Act).
- **A clinician uploading a patient's chart**: this is PHI under HIPAA. Needs a BAA
  with the model provider (a BAA-eligible endpoint, which Groq's free tier is not), plus authentication,
  audit logging and TLS. The app has none of those today.

Not legal advice. Get a healthcare attorney before real patient data.

## Structure

```
index.html
tailwind.config.js      # content globs + custom `flash` keyframe (CONFLICT badge)
postcss.config.js
vite.config.js
src/
  main.jsx
  index.css             # tailwind directives, base styles, skeleton shimmer
  App.jsx               # state machine, API call, layout
  mockData.js           # presentation-mode payload
  lib/
    pdfText.js          # pdf.js text extraction, in-browser (worker bundled locally)
    deidentify.js       # Safe Harbor scrubber: see limitations above
  components/
    Header.jsx          # mark, presentation toggle, de-ID badge + tooltip
    IngestionPanel.jsx  # trial URL, drag/drop + browse, run button
    RedactionReview.jsx # review gate: blocks transmission until approved
    PatientChecklist.jsx# left rail, color-coded by category
    ComplianceMatrix.jsx# summary strip + MATCH / CONFLICT / UNKNOWN rows
```

## Request flow

```
Run clicked
  └─ PHASE 1 (local only, no network)
       pdfText.extractPdfText(file)     → raw text
       deidentify(raw)                  → redacted text + counts
       RedactionReview opens            ← BLOCKS HERE until human approves
  └─ PHASE 2 (only on explicit approval)
       POST /api/analyze { trial_url, patient_text, session_id }
```
