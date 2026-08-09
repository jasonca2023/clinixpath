# ClinixPath

Clinical trial eligibility screening. Drop in a medical record and ClinixPath strips the identifiers in your browser, then checks the chart against every recruiting study on ClinicalTrials.gov.

Every criterion resolves to met, blocked, or a gap, and each verdict carries the sentence it came from. Gaps are ranked by how many trials they unblock, so the most useful test to order next sits at the top.

**Not a medical device.** Decision support for a clinician to check, never an enrolment decision.

---

## How it works

1. **The record never leaves your device.** The PDF is parsed by pdf.js in the tab, and a HIPAA Safe Harbor scrubber removes names, record numbers, dates, addresses and contacts. You read the exact text that would be sent, edit it, and approve it. Nothing transmits until you press send.
2. **The condition is derived from the record** and searched against currently-recruiting studies, filtered to sites near your patient.
3. **Each trial is scored criterion by criterion.** Every verdict quotes the sentence it rests on, from the chart and from the protocol, and those quotes are highlighted in the original documents.
4. **Gaps become a worklist.** A criterion the chart is silent on is not a failure, it is a test to order — ranked by how many trials answering it would unblock.

## Running it

Two processes. The backend uses OpenAI for analysis, with Groq and Cloudflare available as fallbacks.

```bash
# backend  ->  http://localhost:8000
cd backend
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then add a key, see below
./.venv/bin/python -m uvicorn main:app --port 8000 --reload
```

```bash
# frontend ->  http://localhost:5173
cd frontend
npm install
npm run dev
```

Requires Python 3.11+ and Node 18+.

### Keys

`backend/.env` needs a fresh OpenAI key. In the default configuration, OpenAI is tried first; configured [Groq](https://console.groq.com/keys) and [Cloudflare Workers AI](https://dash.cloudflare.com/profile/api-tokens) credentials are used only if it fails:

```
LLM_PROVIDER=openai
OPENAI_API_KEY=...
GROQ_API_KEY=...                # optional fallback
CLOUDFLARE_ACCOUNT_ID=...       # optional fallback, required with token
CLOUDFLARE_API_TOKEN=...        # optional fallback
```

Do not commit `.env` or paste a key into frontend code. Any other configured preset in `LLM_PRESETS` is also a fallback, so a failed provider does not end a run.

## Tests

```bash
cd backend  && ./.venv/bin/python eval/run.py --plumbing-only   # free, no model calls
cd backend  && ./.venv/bin/python eval/run.py                   # + 8 labelled model cases
cd frontend && node src/lib/deidentify.test.mjs                 # 34 Safe Harbor cases
cd frontend && node src/lib/tokens.test.mjs                     # design-token invariants
```

The eval is the part worth reading. Alongside the reasoning cases — same trial, same cancer, opposite verdicts — there are deterministic checks for the defects that actually shipped: an empty matrix scoring as a perfect match, a caller-supplied URL reaching localhost, a truncated response counting as a success, a chart truncated from the wrong end.

## Limits

- **Not HIPAA compliant.** No BAA with the model provider, no authentication, no audit log. Built for synthetic records, or records already de-identified to your institution's standard.
- **The scrubber misses identifiers written as prose.** Labelled fields, record numbers, dates and addresses are removed reliably. A bare first name, a hospital, or a city inside a sentence is not. That is why you read and approve the text before it is sent.
- **Only part of a long chart is read.** The record is capped before it reaches the model; when that happens the result says so, and both ends of the chart are kept rather than the opening alone.
- **Free tiers are the binding constraint.** A discovery run is four model calls, and free quotas run out well before the code does.

## Licence

MIT — see [LICENSE](LICENSE).
