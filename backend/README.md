# ClinixPath: Backend

A completely **stateless, ephemeral** FastAPI service that cross-references
de-identified patient text against a clinical trial's inclusion/exclusion criteria and
returns a structured **compliance matrix**.

- No database. No disk writes. No logging of medical content.
- **The PDF never reaches this service.** It is parsed and de-identified in the browser;
  this endpoint accepts a `patient_text` form field, not a file upload.
- Submitted text is re-screened for direct identifiers and **rejected with `422`** if any
  remain; a caller bypassing the frontend cannot push PHI through to the model.
- CORS is restricted to the local frontend origins, not `*`.
- Trial criteria come from the official [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api): public, no key, no scraping service.
- Analysis runs on **any OpenAI-compatible provider** (Groq, Cerebras, OpenRouter,
  Together, OpenAI, DeepSeek, local Ollama) plus Anthropic: called with `requests`,
  no vendor SDK. The provider is auto-detected from whichever key is in `.env`.
  Output is validated against a rigid Pydantic schema before it reaches the frontend.
- Every buffer holding patient data is explicitly purged in a `finally` block before the
  response leaves the process.

> **Not HIPAA compliance.** Two independent reasons:
>
> 1. Text is sent to a third-party model API with no BAA in place. Handling real PHI
>    needs a BAA-covered endpoint, which this does not use.
> 2. The client-side scrubber is regex-based and **measurably incomplete**; it misses
>    narrative names, facility names, cities and employers. See
>    `../frontend/README.md` for the tested failure list.
>
> This service is also unauthenticated (`session_id` is hardcoded to `demo-user`), has
> no audit logging, and runs over plain HTTP. **Demo with synthetic data.**

---

## 1. Setup

```bash
cd /Users/jasong/ClinixPath/backend

# Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt
```

## 2. Configure the API key

ClinixPath needs exactly **one** model API key, from any supported provider. Drop it in
`.env` and the backend detects which one you used: no code change.

| Provider | Cost | Signup |
| --- | --- | --- |
| Groq | free | <https://console.groq.com/keys> |
| Cerebras | free | <https://cloud.cerebras.ai> |
| OpenRouter | free tier | <https://openrouter.ai/keys> |
| Together | free credits | <https://api.together.ai/settings/api-keys> |
| Anthropic | paid | <https://console.anthropic.com/settings/keys> |
| OpenAI | paid | <https://platform.openai.com/api-keys> |
| **Ollama** | **free, offline, no signup** | `brew install ollama` |

Then:

```bash
export GROQ_API_KEY="your_key_here"
```

Or use a `.env` file, `main.py` loads `backend/.env` automatically on startup
(real environment variables take precedence over the file):

```bash
cp .env.example .env
# edit .env and paste your key, then just start the server: no export needed.
```

Get a free key at <https://console.groq.com/keys>. No credit card, and the free tier is
enough to run this app.

If you later see `model not found`, Groq has retired that model ID: pick a current one
from <https://console.groq.com/docs/models> and set `GROQ_MODEL` in `.env`.

The app never crashes at import time when the key is missing; it returns a clear
**500** with an explanatory message at request time instead. `GET /health` reports
whether a key is configured as a boolean; the key value is never echoed.

## 3. Run

```bash
uvicorn main:app --reload --port 8000
```

Interactive docs: <http://localhost:8000/docs>

---

## API

### `GET /` and `GET /health`

```json
{
  "status": "ok",
  "service": "ClinixPath API",
  "version": "1.0.0",
  "llm_api_key_configured": true,
  "stateless": true
}
```

### `POST /api/analyze`

`multipart/form-data`

| Field          | Type   | Description                                             |
| -------------- | ------ | ------------------------------------------------------- |
| `trial_url`    | string | Public URL of the clinical trial page                   |
| `patient_text` | string | **De-identified** patient record text (no file upload)  |
| `session_id`   | string | Optional, defaults to `demo-user`                       |

#### curl example

```bash
curl -X POST http://localhost:8000/api/analyze \
  -F "trial_url=https://clinicaltrials.gov/study/NCT04613596" \
  -F "patient_text=58-year-old male. ANC 1,200 cells/uL. EGFR Exon 19 Deletion Positive." \
  -H "Accept: application/json"
```

Text containing direct identifiers is rejected:

```bash
curl -X POST http://localhost:8000/api/analyze \
  -F "trial_url=https://clinicaltrials.gov/study/NCT04613596" \
  -F "patient_text=John Doe SSN 123-45-6789"
# 422, "still contains direct identifiers (SSN)"
```

#### Response shape

```json
{
  "patient_summary": [
    {
      "category": "LAB_VALUES",
      "metric_name": "Absolute Neutrophil Count",
      "extracted_value": "1,750 cells/µL"
    }
  ],
  "compliance_matrix": [
    {
      "id": "node_1",
      "category": "LAB_VALUES",
      "patient_fact": "Absolute Neutrophil Count (ANC): 1,750 cells/µL",
      "trial_rule": "ANC > 1,500 cells/µL",
      "status": "MATCH",
      "explanation": "The patient's ANC baseline satisfies the inclusion threshold."
    }
  ]
}
```

`category` in `patient_summary` is one of `GENETICS`, `LAB_VALUES`, `COMORBIDITIES`,
`DEMOGRAPHICS`, `MEDICATIONS`. `status` is one of `MATCH`, `CONFLICT`, `UNKNOWN`.

#### Error codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 400  | Empty `trial_url` / `patient_text`, or a failed trial-URL fetch              |
| 422  | Submitted text still contains direct identifiers: refused, not forwarded    |
| 500  | `GROQ_API_KEY` not configured on the server                                 |
| 502  | LLM call failed, or its JSON did not validate against `ClinixPathPayload`    |

Pipeline order is input validation → identifier screen → trial fetch → AI, so bad input
surfaces as `4xx` before the LLM credential is even checked.

---

## How trial criteria are resolved

Two paths, neither of which needs an API key:

| Input URL | Path |
| --- | --- |
| Contains an NCT id (`NCT01234567`) | **ClinicalTrials.gov API v2**, `GET /api/v2/studies/{nct_id}`, returns criteria already structured |
| Anything else | Direct `requests.get`, then a stdlib `html.parser` pass to plain text |

The registry path is preferred because it returns the protocol's actual eligibility text
plus the surrounding constraints the criteria block usually omits (phase, min/max age,
sex, healthy-volunteer flag): with none of the page chrome a scraper would drag in.
Less noise into the prompt means a cleaner matrix out.

`GROQ_API_KEY` is the only credential this service needs.

---

## Notes

- **No scraping service.** An earlier draft used Jina Reader, which the PRD names in
  section 2. It was removed: it required a third-party dependency and, in practice,
  started returning `401 AuthenticationRequiredError` for *all* anonymous requests from
  many consumer networks ("bad network reputation"), which made every live audit fail.
  The registry API is authoritative, faster, and configuration-free.
- **No HTML-parsing dependency.** The non-registry fallback uses `html.parser` from the
  stdlib rather than BeautifulSoup/lxml: see `_TextExtractor` in `main.py`. It drops
  `script`/`style`/`nav`/`footer` and turns block tags into newlines.
- **Context caps.** PDF text is truncated to 40,000 characters and trial criteria text
  to 30,000 characters so a large chart cannot blow the free-tier context
  window. Adjust `MAX_PDF_CHARS` / `MAX_TRIAL_CHARS` in `main.py`.
- **Blocking I/O.** `requests.get` and the LLM call both run via
  `asyncio.to_thread(...)` so the async endpoint never stalls the event loop.
- **CORS is restricted**, not `*`. Defaults to `localhost`/`127.0.0.1` on ports 5173
  and 4173; override with `ALLOWED_ORIGINS="https://a,https://b"`. A wildcard would let
  any page the user happens to visit POST patient text to this service.
- **No PDF dependency.** `pdfplumber` was removed when parsing moved to the browser.
  This service handles text only and cannot accept a file upload.
- **`.env` is loaded automatically** via `python-dotenv` (`backend/.env`). Real
  environment variables take precedence over the file.

## Frontend

The React frontend lives at `../frontend`. The two trees stay separate/unmerged. The
frontend posts a `multipart/form-data` body with the `trial_url`, `patient_text` and
`session_id` fields shown above to `http://localhost:8000/api/analyze`.

The frontend owns PDF parsing and de-identification (`../frontend/src/lib/`). This
service only ever sees text a clinician has explicitly approved for transmission.
Do not merge the two trees.
