"""
ClinixPath: stateless clinical-trial eligibility cross-referencing backend.

Single-file FastAPI service. Nothing is persisted:
  * The patient PDF never reaches this service. It is parsed and de-identified in the
    browser (frontend/src/lib/), and only clinician-approved text is POSTed here.
  * Trial criteria are fetched over plain HTTPS and kept only as a local string.
  * Every buffer is explicitly dropped in a `finally` block before the response is returned.
  * Submitted text is re-checked for direct identifiers and rejected if any remain,
    so a caller bypassing the browser cannot push PHI through to the model.

There is no database, no cache and no logging of medical content: by design.

Third-party surface is deliberately minimal: trial criteria come from the official
ClinicalTrials.gov API v2 (no key, authoritative, already structured). Any other host
falls back to a direct fetch plus a stdlib HTML-to-text pass: no scraping service and
no HTML-parsing dependency.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
import time
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from html import unescape
from html.parser import HTMLParser
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError


# ---------------------------------------------------------------------------
# 1. CONFIGURATION & INFRASTRUCTURE
# ---------------------------------------------------------------------------

# Load backend/.env if present. Real environment variables always win, so an
# exported GROQ_API_KEY overrides the file.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

APP_TITLE = "ClinixPath API"
APP_VERSION = "1.0.0"

# Timing only. NEVER medical content — the stateless guarantee in the module
# docstring is not negotiable, so these lines carry durations, model names and
# NCT ids and nothing else. No record text, no prompts, no model output.
#
# The first version of this block broke that guarantee twice, three lines under
# the docstring that states it:
#
#   1. It logged the derived search condition. A diagnosis IS medical content.
#   2. It logged exception text on failure — and for an HTTP error that text
#      comes from _extract_provider_error, i.e. the provider's raw response body,
#      which can echo the submitted prompt straight back.
#
# Failures now log the exception TYPE and the HTTP status, which is what actually
# tells you whether a run was slow because of throttling, a timeout or a bad
# key. The message itself still reaches the caller, where it is wanted; it just
# does not get written down. `_safe_error` below is the chokepoint.
#
# This exists because a discovery run took nine and a half minutes on screen and
# there was no way to say WHY: uvicorn's access log records the status code and
# not the duration, so "which phase was slow" was unanswerable after the fact and
# every explanation was arithmetic rather than evidence.
def _safe_error(exc: BaseException) -> str:
    """
    A loggable description of a failure that cannot carry medical content.

    Returns the exception type plus, for provider failures, the HTTP status code
    parsed out of our own message format. Never the provider's response body.
    """
    text = str(exc)
    # Two formats. Ours reads "... returned HTTP 413: ..."; `requests` raises
    # "429 Client Error: Too Many Requests for url: ...". Only the first was
    # recognised, so a throttled registry fetch logged as a bare "HTTPError" and
    # two trials were dropped from a real run with no way to tell why.
    match = re.search(r"HTTP (\d{3})", text) or re.match(r"\s*(\d{3})\b", text)
    status = f" HTTP {match.group(1)}" if match else ""
    # Phrases that are OURS, not the provider's, so surfacing them cannot leak a
    # response body. Each names a failure mode whose fix is different, and without
    # them these all log as a bare "RuntimeError" — which is what a truncated
    # response did on a real discovery run, indistinguishable from any other fault.
    kind = ""
    lowered = text.lower()
    if "rate limit" in lowered:
        kind = " rate-limited"
    elif "truncated its response" in lowered:
        kind = " output-truncated"
    elif "empty response body" in lowered:
        kind = " empty-body"
    return f"{type(exc).__name__}{status}{kind}"


log = logging.getLogger("clinixpath.timing")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s  timing  %(message)s", "%H:%M:%S"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

# --- LLM provider (any OpenAI-compatible endpoint) --------------------------
#
# Groq, OpenAI, OpenRouter, Together, DeepSeek, Cerebras, Fireworks and local
# runtimes (Ollama, LM Studio) all speak the same chat-completions protocol, so a
# single `requests` POST covers all of them: no vendor SDK. Pick one by setting
# LLM_BASE_URL / LLM_MODEL / <PROVIDER>_API_KEY in .env. Presets below.
#
# Anthropic uses a different wire format and is handled separately.

LLM_PRESETS: Dict[str, Dict[str, str]] = {
    # Cloudflare Workers AI. Serves OpenAI's open-weight gpt-oss family on a
    # permanent free tier (10k neurons/day, no card) with no cold starts.
    #
    # The odd one out in this table: its base URL embeds the ACCOUNT ID, so the
    # preset carries a {account_id} placeholder that _resolve_preset fills from
    # CLOUDFLARE_ACCOUNT_ID. Every other provider has a fixed host.
    "cloudflare": {
        "base_url": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
        "model": "@cf/openai/gpt-oss-120b",
        "key_env": "CLOUDFLARE_API_TOKEN",
        "signup": "https://dash.cloudflare.com/profile/api-tokens (use the Workers AI template)",
        # Measured: at "low" this serving returns a full 10-row matrix, 3/3 on the
        # eval assertions, faster and at half the neuron cost of "medium".
        "reasoning_effort": "low",
        # 8192 was OUR number, not Cloudflare's: the endpoint accepts 32,768. It
        # was low enough that a full-size record (MAX_PDF_CHARS of chart plus a
        # long criteria list) produced a matrix that did not fit, and since Groq
        # 413s on the same input there was no provider left — a real chart 502'd
        # outright. Unlike Groq's TPM, this is a ceiling and not a reservation, so
        # raising it costs no neurons on the runs that never approach it.
        "max_output_tokens": "16384",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
        "key_env": "GROQ_API_KEY",
        "signup": "https://console.groq.com/keys",
        # Groq needs DIFFERENT settings from Cloudflare for the same weights.
        #
        # reasoning_effort: at "low" this serving under-reasons badly — 4 rows and
        # 2/3 on the eval, against 10 rows and 3/3 at "medium". Identical model,
        # identical prompt; the serving stack differs. Never assume a parameter
        # tuned on one host transfers to another.
        #
        # max_output_tokens: the free tier's 8,000 TPM budget is charged on
        # prompt + max_tokens AT REQUEST TIME, before a token is generated. At
        # 8192 every call was rejected 413 outright. 5,000 leaves room for a
        # ~2,400-token prompt inside the window.
        #
        # unsupported: Groq answers `reasoning` with "property 'reasoning' is
        # unsupported" — a hard 400. The strip-and-retry below recovered it, so
        # this was invisible for as long as it shipped, but it meant the PRIMARY
        # provider spent a wasted round-trip on 100% of calls before doing any
        # work. Declaring it here builds the right payload the first time.
        # gpt-oss on Groq routes its trace to a separate `reasoning` field, so
        # dropping the key costs nothing: no chain-of-thought reaches `content`.
        "reasoning_effort": "medium",
        "max_output_tokens": "5000",
        "unsupported": "reasoning",
        # Declaring the TPM ceiling lets the caller SIZE the reservation to what is
        # actually left, instead of always asking for 5,000 and being refused.
        # Measured: a 1,360-character record was rejected at "Requested 8,153,
        # Limit 8,000" — the fixed prompt is ~2,300 tokens, so a flat 5,000-token
        # reservation left roughly 700 tokens for the record and the criteria
        # combined, and Groq 413'd on essentially every real input.
        "tpm_limit": "8000",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "key_env": "OPENAI_API_KEY",
        "signup": "https://platform.openai.com/api-keys",
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "key_env": "TOGETHER_API_KEY",
        "signup": "https://api.together.ai/settings/api-keys",
    },
    "cerebras": {
        "base_url": "https://api.cerebras.ai/v1",
        "model": "llama-3.3-70b",
        "key_env": "CEREBRAS_API_KEY",
        "signup": "https://cloud.cerebras.ai",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "key_env": "DEEPSEEK_API_KEY",
        "signup": "https://platform.deepseek.com/api_keys",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "model": "claude-sonnet-5",
        "key_env": "ANTHROPIC_API_KEY",
        "signup": "https://console.anthropic.com/settings/keys",
    },
    # Free inference using accounts you likely already have.
    "github": {
        "base_url": "https://models.github.ai/inference",
        "model": "openai/gpt-4o",
        "key_env": "GITHUB_TOKEN",
        "signup": "https://github.com/settings/tokens (fine-grained token, Models: read)",
    },
    "huggingface": {
        "base_url": "https://router.huggingface.co/v1",
        "model": "meta-llama/Llama-3.3-70B-Instruct",
        "key_env": "HF_TOKEN",
        "signup": "https://huggingface.co/settings/tokens",
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "model": "mistral-large-latest",
        "key_env": "MISTRAL_API_KEY",
        "signup": "https://console.mistral.ai/api-keys",
    },
    "nvidia": {
        "base_url": "https://integrate.api.nvidia.com/v1",
        "model": "meta/llama-3.3-70b-instruct",
        "key_env": "NVIDIA_API_KEY",
        "signup": "https://build.nvidia.com (free credits)",
    },
    "ollama": {  # local, no key needed
        "base_url": "http://localhost:11434/v1",
        "model": "llama3.3",
        "key_env": "OLLAMA_API_KEY",
        "signup": "https://ollama.com (runs offline on your machine)",
    },
}


def _active_provider() -> Dict[str, str]:
    """
    Resolve the provider config.

    Explicit LLM_PROVIDER wins. Otherwise the first preset whose key env var is
    populated is used, so dropping any supported key into .env is enough.
    """
    requested = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if requested in LLM_PRESETS:
        chosen = requested
    else:
        if requested:
            # A typo used to fall through to auto-detection in silence, so
            # LLM_PROVIDER=grok ran happily on whatever key happened to be set
            # and every symptom pointed at the wrong provider.
            log.info(
                "config    LLM_PROVIDER=%r is not a known preset (%s); "
                "falling back to auto-detection",
                requested,
                ", ".join(LLM_PRESETS),
            )
        chosen = next(
            (
                name
                for name, cfg in LLM_PRESETS.items()
                if os.environ.get(cfg["key_env"], "").strip()
            ),
            "groq",
        )

    return _resolve_preset(chosen, primary=True)


def _resolve_preset(name: str, primary: bool) -> Dict[str, str]:
    """
    Materialise one preset, applying the env overrides.

    LLM_BASE_URL/LLM_MODEL describe the PRIMARY provider only. Applying them to a
    fallback would be actively harmful: pointing Groq at OpenRouter's base URL, or
    asking it for `nvidia/nemotron-...:free`, guarantees the fallback fails in the
    exact moment it is needed. Fallbacks use their preset defaults.
    """
    preset = dict(LLM_PRESETS[name])
    preset["name"] = name
    if primary:
        preset["base_url"] = os.environ.get(
            "LLM_BASE_URL", preset["base_url"]
        ).rstrip("/")
        preset["model"] = os.environ.get("LLM_MODEL", preset["model"])
    else:
        preset["base_url"] = preset["base_url"].rstrip("/")

    # Cloudflare routes by account, so the id is part of the path rather than a
    # header. Left unresolved it would POST to a literal "{account_id}" and come
    # back as an opaque 400, so it is substituted here and its absence is named.
    if "{account_id}" in preset["base_url"]:
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        if not account_id:
            raise RuntimeError(
                "CLOUDFLARE_ACCOUNT_ID is not set. Workers AI puts the account id "
                "in the request URL, so the token alone is not enough. Find it on "
                "the right-hand side of any Cloudflare dashboard page, or in the "
                "dashboard URL after /accounts/."
            )
        preset["base_url"] = preset["base_url"].replace("{account_id}", account_id)

    return preset


def _provider_chain() -> List[Dict[str, str]]:
    """
    The ordered list of providers to try for a single analysis.

    Two vendors died under this app in one day: GitHub Models was retired outright,
    and a model that was free in the morning was paid-only by the afternoon. A
    single-provider design turns either event into a dead demo, so every configured
    credential becomes a standby.

    The primary comes first; every other preset holding a usable key follows, in
    declaration order. Nothing needs configuring for this to work — adding a second
    key to .env is the whole setup.
    """
    primary = _active_provider()
    chain = [primary]
    seen = {primary["name"]}

    for name, cfg in LLM_PRESETS.items():
        if name in seen:
            continue
        # Ollama needs no key, but it is local: silently falling back to a machine
        # that probably is not running one would trade a clear provider error for a
        # confusing connection refused.
        if name == "ollama":
            continue
        if os.environ.get(cfg["key_env"], "").strip():
            try:
                chain.append(_resolve_preset(name, primary=False))
            except RuntimeError:
                # A fallback that cannot be resolved (e.g. a Cloudflare token with
                # no account id) is simply not a fallback. Skipping it is correct;
                # raising here would let a half-configured standby take down the
                # primary, which is the opposite of what a fallback is for.
                continue
            seen.add(name)

    return chain


# `requests` takes (connect, read). The read value is the maximum gap BETWEEN
# bytes, not the total duration of the call — a distinction that mattered here: a
# single scalar of 90 let a response that trickled steadily run for four minutes
# without ever tripping the guard, because no individual gap exceeded 90s.
#
# The tuple bounds a genuinely stalled socket quickly. Total wall-clock is bounded
# separately by LLM_TOTAL_TIMEOUT_SECONDS at the await sites, since `requests` has
# no notion of an overall deadline.
#
# THE READ VALUE IS NOT A STALL DETECTOR HERE. These responses are not streamed, so
# the model generates in silence and the entire answer arrives as one burst: the
# "gap between bytes" is the whole generation time. A read timeout therefore acts
# as a hard ceiling on how long a model may think, and cannot tell a slow answer
# from a dead socket.
#
# Measured on a real discovery run: Cloudflare returned complete answers at 55.8s
# and 56.2s, and hit ReadTimeout three times at 60.1s. At 60 the margin was four
# seconds, so a trial that took one second longer than the two that succeeded was
# thrown away — and one trial was lost entirely when both providers missed. 120
# leaves real headroom while staying under the 150s wait_for that is the actual
# ceiling. A genuinely stalled socket is still caught there.
LLM_TIMEOUT_SECONDS: tuple[int, int] = (10, 120)

# Hard ceiling on one model call, enforced with asyncio.wait_for. Free tiers queue
# behind paid traffic and can take minutes; past this point the run is more useful
# to the clinician as a clear error than as a spinner that may never resolve.
LLM_TOTAL_TIMEOUT_SECONDS = 150

# Ceiling on the whole scoring phase of /api/discover, which fans out over several
# trials and retries each one. Without it the worst case is (trials / concurrency)
# waves x 2 attempts x LLM_TOTAL_TIMEOUT_SECONDS, which ran past the browser's own
# abort: the tab gave up and reported a timeout while the server was still working,
# so the user saw a failure for a run that would have succeeded.
#
# Enforced as a DEADLINE rather than a wait_for around the gather. Cancelling the
# gather would throw away every trial already scored; checking a deadline before
# starting more work keeps those and reports the rest as failures, which is the
# same contract a single trial failure already has.
#
# It bounds when new work STARTS, so the true ceiling for /api/discover is:
#   derive terms (150) + registry search (30) + this (300) + one in-flight call (150)
#   = 630s
# The browser's abort in frontend/src/App.jsx must stay above that number. If you
# change this, change that.
DISCOVERY_TOTAL_TIMEOUT_SECONDS = 300

# How many trials are scored in parallel.
#
# This was 2, chosen defensively when the concern was "free tiers rate-limit
# aggressively". The arithmetic says that was far too cautious: OpenRouter's free
# tier allows 20 requests per MINUTE, and a call that takes ~86s means four in
# flight is under 3 req/min — an order of magnitude inside the limit. The cost of
# the caution was real, though: 6 trials at concurrency 2 is three sequential
# waves, so the setting alone added ~90s to every run.
#
# Env-tunable because the right value depends entirely on the provider. On Groq
# (30 RPM, ~500 tok/s) this can go higher; on a slower free tier, lower.
#
# Now tuned for the PRIMARY provider, which is Groq. Its free tier caps TOKENS
# PER MINUTE at 8,000 and charges prompt + max_tokens at request time, so one
# analysis reserves ~7,300 of that window. Four in flight is ~29,000 against
# 8,000: three of the four get a 413 immediately and fall through to Cloudflare.
# That works — it is what the chain is for — but it means the fast provider was
# serving one trial in four, so the run paid Cloudflare's latency for most of it
# while burning Cloudflare's neuron budget too.
#
# 2 keeps one call inside Groq's window with the next queued behind it, and
# leaves the fallback for genuine failures rather than for self-inflicted ones.
def _env_int(name: str, default: int, minimum: int = 1) -> int:
    """
    Read an integer setting without letting a typo kill the process.

    These are read at import time, so `DISCOVERY_CONCURRENCY=two` in .env took
    the server down with a bare ValueError traceback and no mention of which
    variable was at fault — the least useful possible failure for a config
    mistake. A bad value now warns and falls back to the shipped default.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(minimum, int(raw.strip()))
    except ValueError:
        log.info(
            "config    %s=%r is not an integer; using the default %d",
            name, raw.strip()[:40], default,
        )
        return default


DISCOVERY_CONCURRENCY = _env_int("DISCOVERY_CONCURRENCY", 2)

# Default number of trials to score per run. Six meant seven model calls; on a
# queue where one call is ~86s that is minutes of wall clock for results the user
# reads top-down anyway. Four is one full wave at the concurrency above.
DEFAULT_MAX_TRIALS = _env_int("DEFAULT_MAX_TRIALS", 4)

# Free-tier context windows are finite and a 300-page chart would blow the budget
# (and the latency SLA). These caps keep a single request comfortably inside the
# free tier while still covering a realistic patient chart.
# Output budget for one call.
#
# The OpenAI branch used to send no max_tokens at all, relying on each provider's
# default being generous. Cloudflare's is 256 — and gpt-oss is a reasoning model,
# so all 256 were consumed by chain-of-thought before a single character of the
# answer was written. The call returned HTTP 200, finish_reason "length", and an
# empty `content`: a success by every signal except the one that matters.
#
# This has to cover REASONING PLUS ANSWER, not just the answer, which is why it is
# well above what a 12-row matrix needs on its own.
LLM_MAX_OUTPUT_TOKENS = _env_int("LLM_MAX_OUTPUT_TOKENS", 8192, minimum=256)

# How much chain-of-thought the model is allowed to spend before answering.
#
# Measured on the real prompt against @cf/openai/gpt-oss-120b:
#
#   low     16.3s   2,404 output tokens   238 neurons   10 rows   3/3 correct
#   medium  22.2s   4,018 output tokens   348 neurons    9 rows   3/3 correct
#   high    51.0s   8,192 output tokens   632 neurons   TRUNCATED, unparseable
#
# "low" is not a compromise here, it is strictly better on every axis: fastest,
# cheapest, MORE rows than medium, and fully correct. "high" is actively harmful —
# it spends the entire output budget reasoning and the JSON never closes.
#
# The lesson generalises: this task is extraction and comparison against an
# explicit rubric, not open-ended problem solving. There is little for extended
# deliberation to discover, so it mostly buys latency and a truncation risk.
LLM_REASONING_EFFORT = os.environ.get("LLM_REASONING_EFFORT", "low").strip()

# Below this, a provider cannot produce a usable compliance matrix, so it is
# skipped rather than sent a request that will truncate. A measured full analysis
# ran to 4,816 completion tokens; this is the point past which the answer would be
# cut so short that failing over is strictly better.
_MIN_USEFUL_OUTPUT_TOKENS = 2_000

# How much of the patient record reaches the model.
#
# Was 40,000, a number sized for an 8,192-token output ceiling that no longer
# applies. Measured on a 127,769-character chart of serial oncology notes, 40,000
# meant the model read 31% of the document — and a criterion answered from 31% of
# a chart is answered from the wrong evidence, however honestly the shortfall is
# reported. gpt-oss-120b carries a 128k-token context, so ~25k tokens of record
# plus ~7.5k of criteria plus a ~2.3k prompt and 16k of output sits well inside it.
#
# Env-tunable because the right value depends on the provider actually configured,
# and finding that out should not require editing code. `_shrink_on_overflow`
# below is what makes raising it safe: if the ceiling turns out to be lower than
# this, the request is retried smaller instead of failing.
MAX_PDF_CHARS = _env_int("MAX_RECORD_CHARS", 100_000, minimum=1_000)

# Discovery reads the record ONCE PER TRIAL, so the cap above is multiplied by the
# size of the shortlist: at four trials, 100,000 characters is ~156,000 tokens for
# a single run. That is the difference between a handful of runs a day and a
# comfortable margin, and it lands on the budget that is already the binding
# constraint.
#
# The two endpoints are doing different jobs, so they get different budgets.
# /api/discover SCREENS: it ranks many trials to decide which deserve attention,
# and head-and-tail already puts the diagnosis, the molecular profile and the
# recent labs inside 40,000 characters. /api/analyze ADJUDICATES one trial, and is
# where a fact buried mid-chart changes a verdict a clinician will act on.
#
# Raise this to MAX_RECORD_CHARS once the provider is paid rather than free; the
# multiplier stops mattering and deeper screening is strictly better.
DISCOVERY_MAX_RECORD_CHARS = _env_int("DISCOVERY_MAX_RECORD_CHARS", 40_000, minimum=1_000)

MAX_TRIAL_CHARS = 30_000  # ~7.5k tokens of trial criteria text

# Marker left in place of the removed middle, so the model is told a gap exists
# rather than reading two distant notes as consecutive.
_ELISION = "\n\n[... MIDDLE OF RECORD OMITTED TO FIT CONTEXT LIMIT ...]\n\n"


def _fit_record(text: str, limit: int = MAX_PDF_CHARS) -> str:
    """
    Reduce a record to `limit` characters, keeping the beginning AND the end.

    A plain `text[:limit]` keeps the OPENING of the chart, which is the wrong
    half. Measured on a 127,769-character chart of serial oncology notes: the
    opening 40,000 characters covered visits 1-19, and the molecular tumour board
    summary carrying the KRAS G12C result, the current disease status and the
    checkpoint-inhibitor history sat at the end and was dropped. The trial's
    defining criterion — "must have documented KRAS G12C-mutated NSCLC" — came
    back UNKNOWN with an empty patient_fact, from a chart that documents it
    explicitly. A verdict that says "we don't know" about a fact the record
    states is worse than a slow one.

    Head and tail rather than tail alone, because charts do not agree on
    chronology: some are oldest-first, some newest-first, and the demographics
    and diagnosis header is nearly always at the top. Keeping both ends is
    correct under either convention. The elision marker is explicit so the model
    does not read across the seam as if it were continuous text.
    """
    if len(text) <= limit:
        return text

    budget = limit - len(_ELISION)
    if budget <= 0:  # pathologically small limit; fall back to a plain cut
        return text[:limit]

    # Weighted to the tail: the most recent material decides eligibility, while
    # the head only needs to carry the identifying and diagnostic header.
    head_chars = budget // 3
    tail_chars = budget - head_chars
    return text[:head_chars] + _ELISION + text[-tail_chars:]


# Phrases providers use when the prompt exceeds the model's context window. Kept
# broad and lowercase: every vendor words this differently and a missed phrase
# turns a recoverable request into a failed one.
_CONTEXT_OVERFLOW_MARKERS = (
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "reduce the length",
    "request too large",
    "prompt is too long",
    "no room for this request",
)


# Failures that sending less text cannot fix. Checked FIRST, because the chain's
# aggregate error concatenates every provider's message: if Groq says "no room for
# this request" and Cloudflare says "rate limit reached", a naive substring test
# sees the context phrase and shrinks the record, spending another full round of
# quota on a request that was never going to be admitted.
_UNSHRINKABLE_MARKERS = (
    "rate limit",
    "http 429",
    "http 401",
    "http 403",
    "invalid api key",
    "truncated its response",
)


def _looks_like_context_overflow(message: str) -> bool:
    """
    True only when EVERY provider in the chain failed for want of context room.

    The chain reports as "All N configured providers failed — a: ... | b: ...".
    Each segment is judged on its own: one provider running out of context while
    another is rate-limited is not a size problem, and retrying smaller would
    just burn the remaining budget.
    """
    lowered = message.lower()
    if any(marker in lowered for marker in _UNSHRINKABLE_MARKERS):
        return False

    body = lowered.split("—", 1)[-1]
    segments = [s for s in body.split(" | ") if s.strip()]
    if not segments:
        return False
    return all(
        any(marker in segment for marker in _CONTEXT_OVERFLOW_MARKERS)
        for segment in segments
    )


def _generate_with_shrink(
    record: str, criteria: str, limit: Optional[int] = None
) -> tuple[str, int]:
    """
    Run the provider chain, halving the record if the context turns out too small.

    Returns (raw model output, characters of record actually sent) so the caller
    can report truncation HONESTLY — the notice must describe what the model was
    really shown, not what we hoped to show it.

    This exists so MAX_PDF_CHARS can be set from what the models can do rather
    than from the smallest thing we are certain of. The previous 40,000 was safe
    and wrong: it discarded two thirds of every real chart to avoid a failure
    nobody had measured. With a retry, an over-large limit costs one wasted call
    on the biggest records instead of silently degrading every one of them.

    Only context overflows are retried. A 401, a 429 or a truncated response are
    not fixed by sending less, and re-sending would just spend more quota.

    `limit` defaults to the adjudication budget. Discovery passes its own, smaller
    one — see DISCOVERY_MAX_RECORD_CHARS for why the two differ.
    """
    limit = MAX_PDF_CHARS if limit is None else limit
    last_error: Exception | None = None

    # Halving from 100,000 reaches ~12,500 characters, below any context window a
    # provider in this table plausibly has. Stopping sooner would leave a record
    # unanalysable on a provider that could have handled a smaller slice.
    previous_size: Optional[int] = None
    for _ in range(4):
        fitted = _fit_record(record, limit)

        # STOP IF SHRINKING CHANGED NOTHING.
        #
        # `_fit_record` returns the record untouched when it already fits, so
        # halving a limit the record is nowhere near produces the identical
        # prompt. Measured: a 3,000-character record against 25,000 characters
        # of criteria sent the SAME 36,405-character prompt four times and paid
        # for four rejections — because the overflow was the criteria, which
        # this loop does not shrink.
        #
        # One attempt is the honest cost of an over-large limit. Four identical
        # ones is just spending quota to be told the same thing again.
        if previous_size is not None and len(fitted) == previous_size:
            log.info(
                "phase     shrink is a no-op at %d chars; the record is not the "
                "thing that overflowed",
                len(fitted),
            )
            break
        previous_size = len(fitted)

        try:
            return _generate_structured_payload(build_prompt(fitted, criteria)), len(fitted)
        except RuntimeError as exc:
            last_error = exc
            if not _looks_like_context_overflow(str(exc)):
                raise
            limit //= 2
            log.info(
                "phase     context overflow, retrying with %d chars of record", limit
            )

    raise last_error if last_error else RuntimeError("record could not be fitted")


FETCH_TIMEOUT_SECONDS = 30
USER_AGENT = "ClinixPath/1.0 (+clinical-trial-eligibility-matcher)"

# Official ClinicalTrials.gov API v2: public, unauthenticated, returns the
# eligibility criteria as structured text. Preferred over scraping the rendered page.
CTGOV_API_TEMPLATE = "https://clinicaltrials.gov/api/v2/studies/{nct_id}"
NCT_ID_PATTERN = re.compile(r"(NCT\d{8})", re.IGNORECASE)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Cap the pool `asyncio.to_thread` runs blocking work in.

    `asyncio.wait_for` cancels the AWAIT, not the thread underneath it. A model call
    that blows LLM_TOTAL_TIMEOUT_SECONDS returns a 504 to the caller while its worker
    keeps running until `requests` gives up on its own — bounded by the 60s read gap
    in the common case, but a response trickling steadily holds a thread for as long
    as it keeps trickling. Python cannot kill a thread, so the honest fix is to cap
    how many can accumulate rather than to pretend they are cancellable.

    32 is comfortably above what a single discovery run needs (concurrency is 2, plus
    registry fetches) and low enough that stranded workers cannot grow without limit.
    """
    executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix="clinixpath")
    asyncio.get_running_loop().set_default_executor(executor)
    try:
        yield
    finally:
        # Do not join: a stranded worker is exactly what this exists to contain, and
        # blocking shutdown on one would hang the process it is protecting.
        executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(
    title=APP_TITLE,
    version=APP_VERSION,
    lifespan=lifespan,
    description=(
        "Stateless clinical trial eligibility matcher. Accepts de-identified patient "
        "text, fetches trial criteria, and returns a structured compliance matrix."
    ),
)

# CORS is restricted to the local frontend. `allow_origins=["*"]` would let any page
# the clinician happens to visit POST patient text to this service; that is not an
# acceptable default for something handling medical data, even locally.
# Override with ALLOWED_ORIGINS="https://host-a,https://host-b" when deploying.
DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Return unhandled errors as CORS-enabled JSON.

    Starlette's default 500 path skips the CORS middleware, so the browser cannot
    read the response and reports a bare "Failed to fetch": hiding the real cause
    (a provider rate limit, say) behind what looks like a network outage. Echoing
    the origin here means the UI can show that something broke server-side.

    The exception's MESSAGE is deliberately not echoed. Every failure this service
    can anticipate is already converted into an HTTPException with wording written
    for a clinician, so anything reaching here is unanticipated by definition — and
    an unanticipated exception raised mid-analysis can carry record text in its
    message (a validator quoting its input, a parser quoting the line it choked on).
    Sending that back to the browser would leak the very content the whole pipeline
    exists to contain. The type name is enough to tell the two cases apart; the full
    traceback still goes to the server log, where uvicorn already prints it.
    """
    origin = request.headers.get("origin", "")
    headers = (
        {"Access-Control-Allow-Origin": origin} if origin in ALLOWED_ORIGINS else {}
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": (
                f"The service hit an unexpected {type(exc).__name__} and stopped this "
                "run. Nothing was retained. Details are in the API server log."
            )
        },
        headers=headers,
    )


# --- outbound request safety ------------------------------------------------
#
# Trial URLs arrive from the client, and anything that is not a registry link is
# fetched by THIS process. Without a check, `trial_url` is a request-forgery
# primitive: the caller picks a host, the server connects to it with the server's
# own network position, and the body comes back in `trial_criteria`. On a laptop
# that reaches localhost; on a deployed host it reaches the private subnet and the
# cloud metadata endpoint (169.254.169.254), which is where instance credentials
# live.
#
# The registry path is unaffected — it builds its own URL from an NCT id.
#
# Empty means "no allowlist": any PUBLIC host is permitted, private ranges are not.
# Set TRIAL_URL_HOSTS="clinicaltrials.gov" to lock fetching to the registry alone.
TRIAL_URL_HOSTS = [
    host.strip().lower()
    for host in os.environ.get("TRIAL_URL_HOSTS", "").split(",")
    if host.strip()
]


def _assert_fetchable_url(url: str) -> None:
    """
    Reject a URL that points anywhere other than a public internet host.

    Raises:
        ValueError: naming the reason, which surfaces in the 400 the caller gets.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Only http and https URLs can be fetched, not {parsed.scheme!r}.")

    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("The trial URL has no host.")

    if TRIAL_URL_HOSTS and host not in TRIAL_URL_HOSTS:
        raise ValueError(
            f"{host} is not in TRIAL_URL_HOSTS. Allowed: {', '.join(TRIAL_URL_HOSTS)}."
        )

    # Resolve and check EVERY address the name maps to. Checking the literal string
    # would miss "localhost", a hostname pointed at 127.0.0.1, and IPv6 forms; a
    # name resolving to both a public and a private address is checked on both.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve {host}: {exc}") from exc

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local  # includes 169.254.169.254, the metadata endpoint
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise ValueError(
                f"{host} resolves to the non-public address {address}. Trial URLs must "
                "point at a public page; this service will not fetch internal hosts."
            )


def _key_for(provider: Dict[str, str]) -> Optional[str]:
    """Read one provider's API key. Generic LLM_API_KEY covers custom gateways."""
    if provider["name"] == "ollama":
        return "local"
    key = os.environ.get(provider["key_env"]) or os.environ.get("LLM_API_KEY")
    return key.strip() if key and key.strip() else None


def get_api_key() -> Optional[str]:
    """
    Read the active provider's API key (never crash at import time).

    Falls back to a generic LLM_API_KEY so a custom gateway works without a preset.
    Local runtimes like Ollama need no key, so those report as configured.
    """
    return _key_for(_active_provider())


def require_api_key() -> None:
    """
    Assert that SOME provider in the chain can be called before an analysis run.

    Checking only the primary, as this did, made the fallback chain unreachable in
    one of the two cases it was built for. "The primary died" is served by the chain
    at call time; "the primary has no credential" was rejected here with a 500
    before the chain was ever walked, even with a working key sitting in .env under
    a different provider's name.

    Raises:
        HTTPException: 500 naming the exact env var and signup URL for the provider.
    """
    try:
        chain = _provider_chain()
    except RuntimeError as exc:
        # The primary is configured but unusable — a Cloudflare token with no
        # account id, say. Say exactly that rather than "no key configured",
        # which would send someone looking for a credential they already have.
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if any(_key_for(provider) for provider in chain):
        return

    provider = _active_provider()
    raise HTTPException(
        status_code=500,
        detail=(
            f"{provider['key_env']} is not configured on the server. "
            f"Get a key at {provider['signup']}, put it in backend/.env, and "
            "restart the API. Any supported provider works: see .env.example."
        ),
    )


# ---------------------------------------------------------------------------
# 2. RIGID PYDANTIC SCHEMAS (structured output verification)
# ---------------------------------------------------------------------------


class ExtractedMetric(BaseModel):
    """A single normalized clinical fact lifted out of the patient record."""

    category: Literal[
        "GENETICS", "LAB_VALUES", "COMORBIDITIES", "DEMOGRAPHICS", "MEDICATIONS"
    ] = Field(
        description="The clinical classification of the extracted patient attribute."
    )
    metric_name: str = Field(
        description="The specific medical marker name (e.g., EGFR, Platelets, Age)."
    )
    extracted_value: str = Field(
        description="The exact quantitative or qualitative value found in the text."
    )


class ComplianceNode(BaseModel):
    """One patient-fact ↔ trial-rule comparison in the compliance matrix."""

    id: str = Field(description="Unique incremental string ID (e.g., node_1, node_2).")
    category: str = Field(
        description="The clinical subfield being evaluated (e.g., Genetics, Lab Thresholds)."
    )
    patient_fact: str = Field(
        description="The extracted patient status or metric relevant to this specific trial rule."
    )
    trial_rule: str = Field(
        description="The exact text of the requirement found in the clinical trial profile."
    )
    status: Literal["MATCH", "CONFLICT", "UNKNOWN"] = Field(
        description=(
            "MATCH if met, CONFLICT if failing safety/eligibility, UNKNOWN if baseline "
            "text is missing from the patient record."
        )
    )
    explanation: str = Field(
        description="A concise, action-oriented medical explanation clarifying the match mapping outcome."
    )
    # --- verifiability: every verdict must be traceable to source text -------
    record_quote: str = Field(
        default="",
        description=(
            "VERBATIM sentence copied character-for-character from the patient record "
            "that this verdict rests on. Empty string only if the record says nothing "
            "relevant. Never paraphrase; this is quoted back to the clinician and "
            "highlighted in the original document."
        ),
    )
    criterion_quote: str = Field(
        default="",
        description=(
            "VERBATIM sentence copied character-for-character from the trial's "
            "eligibility criteria that this verdict rests on. Never paraphrase."
        ),
    )
    # --- actionability: what would resolve an UNKNOWN -----------------------
    data_needed: str = Field(
        default="",
        description=(
            "For UNKNOWN only: the specific test, document, or confirmation that would "
            "resolve this gap, phrased as an order a coordinator could act on: e.g. "
            "'Order CBC with differential' or 'Confirm date of last checkpoint "
            "inhibitor dose'. Empty for MATCH and CONFLICT."
        ),
    )


class TrialCandidate(BaseModel):
    """One recruiting trial scored against the patient record."""

    nct_id: str
    title: str
    phase: str
    status: str
    url: str
    locations: List[str] = Field(default_factory=list)
    site_count: int = 0
    nearby_count: int = 0
    trial_criteria: str = ""
    verdict: Literal["LIKELY_ELIGIBLE", "NEEDS_DATA", "BLOCKED"]
    score: float = Field(description="0-1 ranking score; higher is a better fit.")
    match_count: int = 0
    conflict_count: int = 0
    unknown_count: int = 0
    blockers: int = 0
    open_items: int = 0
    distance_label: str = ""
    compliance_matrix: List[ComplianceNode] = Field(default_factory=list)
    # The model returns a patient summary alongside every matrix it scores. It is
    # carried here rather than dropped so `/api/discover` can union the facts from
    # all scored trials instead of guessing them back out of a single matrix.
    # Excluded from the response: the frontend reads the merged list off the
    # payload root, and repeating it per candidate would multiply the JSON for
    # nothing.
    patient_summary: List[ExtractedMetric] = Field(
        default_factory=list, exclude=True
    )


class SearchTerms(BaseModel):
    """Search keys derived from the record, used to query the registry."""

    condition: str = Field(description="Primary condition, e.g. 'non-small cell lung cancer'.")
    keywords: List[str] = Field(default_factory=list)


class TruncationNotice(BaseModel):
    """
    What the model was NOT shown.

    The context caps are a real constraint, but applying them silently is not
    acceptable in a tool whose output is "this patient conflicts with criterion 4".
    A 40,000-character cap is about sixteen pages of dense clinical text, and a
    genuine oncology chart runs far longer — so on a real record the model reads the
    opening sixth and the clinician receives a complete-looking matrix with no
    indication that most of the chart was never screened. A verdict drawn from part
    of a record has to say so.
    """

    record_truncated: bool = False
    record_chars_used: int = 0
    record_chars_total: int = 0
    criteria_truncated: bool = False


class DiscoveryPayload(BaseModel):
    """Response for the discovery flow: one record, many ranked trials."""

    patient_summary: List[ExtractedMetric] = Field(default_factory=list)
    search_condition: str = ""
    # True when a location was given but returned nothing, so the search was rerun
    # without it. The clinician asked "near me" and got "anywhere"; they have to be
    # told, or they will read a national shortlist as a local one.
    location_relaxed: bool = False
    trials_screened: int = 0
    candidates: List[TrialCandidate] = Field(default_factory=list)
    failed: List[str] = Field(
        default_factory=list,
        description="Trials that could not be scored, with the reason.",
    )
    truncation: TruncationNotice = Field(default_factory=TruncationNotice)


class ClinixPathPayload(BaseModel):
    """The complete response contract handed back to the frontend."""

    # Echoed back so the UI can highlight criterion_quote inside the real protocol
    # text. Excluded from the model's own output: set server-side after validation.
    trial_criteria: str = Field(default="", exclude=False)

    patient_summary: List[ExtractedMetric] = Field(
        description="Structured high-level overview of the patient's parsed attributes."
    )
    compliance_matrix: List[ComplianceNode] = Field(
        description="The core comparison matrix mapping patient metrics directly to trial rules."
    )
    # Set server-side after validation, like `trial_criteria`. The model neither
    # sees nor supplies it; it describes what we did to the inputs before asking.
    truncation: TruncationNotice = Field(default_factory=TruncationNotice)


class HealthResponse(BaseModel):
    """Liveness payload. Reports key presence as a boolean only: never the key."""

    status: str = Field(default="ok")
    service: str = Field(default=APP_TITLE)
    version: str = Field(default=APP_VERSION)
    llm_provider: str = Field(default="")
    llm_model: str = Field(default="")
    llm_api_key_configured: bool = False
    stateless: bool = True


# ---------------------------------------------------------------------------
# 4. THE MASTER INSTRUCTION PROMPT (few-shot training integrated)
# ---------------------------------------------------------------------------
#
# NOTE: this template contains literal JSON braces, so it is deliberately a plain
# module-level constant (NOT an f-string). Substitution is done with str.replace()
# on the two placeholder tokens below: no brace escaping, no format() traps.

PDF_TEXT_TOKEN = "{PATIENT_TEXT}"
TRIAL_TEXT_TOKEN = "{TRIAL_TEXT}"

MASTER_PROMPT_TEMPLATE = """
You are an expert clinical research assistant specializing in oncology and precision medicine trial recruitment. Your processing workspace handles anonymized patient metrics containing no personal PII.
Your objective is to ingest unstructured text from a patient's medical history file and cross-reference it against the inclusion/exclusion criteria found in the trial documentation text.

Study the following golden training example to ground your entity classification, cross-referencing logic, and structural mapping behavior before running:

--- [TRAINING BLOCKS START] ---
Sample Patient Text: "Patient is a 64-year-old male tracking an ongoing history of Stage IV Metastasized Renal Cell Carcinoma. Molecular testing results: VHL somatic mutation detected, MET amplification negative. Current blood draw analytics display a Hemoglobin status of 9.4 g/dL and an Absolute Neutrophil Count (ANC) running at 1,750 cells/µL. Patient is navigating moderate chronic kidney disease with an eGFR metric tracking at 44 mL/min/1.73m². History confirms previous treatment with checkpoint inhibitor lines (Nivolumab), which was ceased 3 months ago due to disease progression."

Sample Trial Text: "Protocol STUDY-RCC-402: Phase III Evaluation of Novel Tyrosine Kinase Inhibitors for Metastasized Renal Oncology. Eligibility Constraints: Inclusion Criteria: 1. Patient age must be >= 18 years at screening. 2. Adequate organ function defined as: Absolute Neutrophil Count (ANC) > 1,500 cells/µL. Exclusion Criteria: 1. Severe underlying renal dysfunction defined as an eGFR < 30 mL/min/1.73m². 2. Any exposure to prior checkpoint immunotherapy lines within a short window of 6 months."

Expected Target JSON Schema Structure:
{
  "patient_summary": [
    {"category": "DEMOGRAPHICS", "metric_name": "Age & Gender", "extracted_value": "64-year-old male"},
    {"category": "GENETICS", "metric_name": "VHL Mutation Status", "extracted_value": "VHL somatic mutation detected"},
    {"category": "LAB_VALUES", "metric_name": "Absolute Neutrophil Count", "extracted_value": "1,750 cells/µL"},
    {"category": "COMORBIDITIES", "metric_name": "Renal Clearance (eGFR)", "extracted_value": "44 mL/min/1.73m²"}
  ],
  "compliance_matrix": [
    {"id": "node_1", "category": "LAB_VALUES", "patient_fact": "Absolute Neutrophil Count (ANC): 1,750 cells/µL", "trial_rule": "Adequate organ function defined as: Absolute Neutrophil Count (ANC) > 1,500 cells/µL.", "status": "MATCH", "explanation": "The patient's ANC baseline perfectly satisfies the safety thresholds outlined in inclusion step 2."},
    {"id": "node_2", "category": "COMORBIDITIES", "patient_fact": "Moderate renal disease with eGFR at 44 mL/min/1.73m²", "trial_rule": "Severe underlying renal dysfunction defined as an eGFR < 30 mL/min/1.73m².", "status": "MATCH", "explanation": "The patient possesses moderate renal clearance but stays safely above the exclusionary cutoff protocol."},
    {"id": "node_3", "category": "MEDICATIONS", "patient_fact": "Prior immunotherapy exposure (Nivolumab) ceased 3 months ago.", "trial_rule": "Excludes any exposure to prior checkpoint immunotherapy lines within a short window of 6 months.", "status": "CONFLICT", "explanation": "The last Nivolumab dose falls inside the protocol's 6-month wash-out window, so this exclusion applies as written."}
  ]
}
--- [TRAINING BLOCKS END] ---

Now evaluate the live input variables following these patterns precisely:
Patient Medical Record: {PATIENT_TEXT}
Clinical Trial Criteria: {TRIAL_TEXT}

Instructions:
- Isolate key biomarkers, genetic mutations, blood metrics, age constraints, and organ dysfunctions.
- Map corresponding items side-by-side. For every critical trial requirement, find the matching fact in the patient record.
- If the patient record completely matches the trial rule, set the status to "MATCH".
- If the patient record directly violates the trial criteria, set the status to "CONFLICT".
- If the trial requires a specific check but the patient record lacks any text mentioning that value, set the status to "UNKNOWN".

CHOOSING BETWEEN THE THREE STATUSES (apply in this order):
- Judge each clause on whether it actually DISCRIMINATES. A criterion like "male or
  female > 18 years of age" constrains only age: every subject is male or female, so
  an unstated gender excludes nobody. Decide on the part that can fail — here, age.
  Do not return UNKNOWN because an incidental, non-discriminating clause is unstated.
- Derive what the record entails rather than demanding it be restated. "62-year-old"
  settles "> 18 years of age". "Completed 4 cycles of carboplatin/pemetrexed" settles
  "no prior chemotherapy" as a CONFLICT. An explicit "no prior radiation" settles a
  radiation exclusion as a MATCH. Only a fact that is genuinely absent is UNKNOWN.
- Read time windows against the dates in the record ("within 5 years prior to
  enrollment", "within 6 months"). If the record gives a therapy but no date, that is
  UNKNOWN on the window, and "data_needed" must ask for the treatment date.
- Reserve UNKNOWN for facts no medical record would contain — informed consent,
  procedure scheduling relative to a future blood draw, an investigator's judgement —
  and for clinical values the record simply never mentions. UNKNOWN is the correct,
  useful answer in those cases, not a failure: it is what "data_needed" exists for.
- A wrong CONFLICT wrongly denies a patient a trial. When a CONFLICT rests on
  inference rather than on something the record states, prefer UNKNOWN and say what
  would settle it.

EVIDENCE REQUIREMENTS (every compliance_matrix entry):
- "record_quote": copy the exact sentence from the Patient Medical Record that your verdict rests on, character for character. Do not paraphrase, summarise, or reformat it. If the record genuinely says nothing on this point, use an empty string.
- "criterion_quote": copy the exact sentence from the Clinical Trial Criteria that your verdict rests on, character for character. Do not paraphrase.
These two strings are shown to a clinician and highlighted inside the original documents, so any deviation from the source text is a defect.

ACTION REQUIREMENT:
- For every entry with status "UNKNOWN", set "data_needed" to the specific test, document, or confirmation that would resolve the gap, written as an instruction a research coordinator can act on today. Examples: "Order CBC with differential to obtain ANC", "Confirm date of last anti-PD-1 dose from oncology notes", "Obtain baseline brain MRI".
- Leave "data_needed" as an empty string for "MATCH" and "CONFLICT".

PATIENT SUMMARY REQUIREMENTS ("patient_summary"):
- This array describes the PATIENT, not the trial. Build it by reading the record start to finish and emitting one entry per distinct clinical fact, whether or not any criterion happens to ask about that fact. A short record is not a licence to return a short summary: it means each fact carries more weight.
- ALWAYS include, when the record states them: the primary diagnosis with its stage and histology, age, performance status (ECOG/Karnofsky), every named biomarker or mutation, every reported lab value, and every prior or current therapy. Omitting the diagnosis leaves a summary of a patient with no disease.
- An explicit negative is a fact, not an absence. "No prior systemic therapy", "no brain metastases", "treatment-naive" each earn their own entry, because a criterion may turn on exactly that.
- The four entries in the training example are an illustration of SHAPE, not a target length. Return as many entries as the record supports.
- CONSOLIDATE ANYTHING THAT REPEATS. A chart of serial visits states the same class of fact at every encounter. Emit ONE entry per KIND of fact, not one per visit: a single "Prior Systemic Therapy" listing the distinct regimens, a single "Absolute Neutrophil Count" giving the most recent value (add the trend only if it is clinically relevant). Never number entries by visit. Twenty near-identical medication rows crowd out the molecular profile and the labs, which is a worse summary than a short one.
- When the record is long, PREFER RECENCY. The current disease status, the latest molecular profile and the most recent labs decide eligibility; superseded values from earlier visits do not belong in the snapshot.

Output your exact answers matching the rigid JSON structure provided. Do not append text warnings or markdown wrapping.
"""


def build_prompt(patient_text: str, trial_text: str) -> str:
    """
    Substitute the two live inputs into the master prompt.

    Uses str.replace() rather than f-strings/format() because the template embeds
    literal JSON braces that would otherwise need escaping.
    """
    prompt = MASTER_PROMPT_TEMPLATE.replace(PDF_TEXT_TOKEN, patient_text)
    prompt = prompt.replace(TRIAL_TEXT_TOKEN, trial_text)
    return prompt


# ---------------------------------------------------------------------------
# BLOCKING HELPERS (executed off the event loop via asyncio.to_thread)
# ---------------------------------------------------------------------------


# Direct identifiers that must never reach the model. Deliberately narrow: this is a
# rejection guard against a caller that skipped the browser, not a de-identifier. The
# real scrubbing happens client-side in frontend/src/lib/deidentify.js.
_IDENTIFIER_GUARDS: Dict[str, "re.Pattern[str]"] = {
    "SSN": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "email address": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),
    # No leading \b; it fails on "(555) 231-8890" since "(" is not a word char.
    "phone number": re.compile(
        r"(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b"
    ),
    "full date of birth": re.compile(
        r"\b(?:DOB|date of birth)\b[^\n]{0,20}?\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", re.I
    ),
}


def _detect_obvious_identifiers(text: str) -> List[str]:
    """Return the names of any direct identifiers still present in the text."""
    return [label for label, rx in _IDENTIFIER_GUARDS.items() if rx.search(text)]


class _TextExtractor(HTMLParser):
    """
    Minimal HTML-to-text pass built on the stdlib parser.

    Deliberately not BeautifulSoup/lxml: this is a fallback for non-registry hosts and
    is not worth a dependency. Script/style/nav content is dropped; block-level tags
    become newlines so the criteria list keeps its shape.
    """

    _SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "header"}
    _BLOCK = {
        "p", "div", "br", "li", "tr", "section", "article",
        "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []
        self._suppress_depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self._SKIP:
            self._suppress_depth += 1
        elif tag in self._BLOCK:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._suppress_depth > 0:
            self._suppress_depth -= 1
        elif tag in self._BLOCK:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._suppress_depth == 0 and data.strip():
            self._parts.append(data)

    def get_text(self) -> str:
        raw = "".join(self._parts)
        # Collapse runs of blank lines and trailing spaces into something compact.
        lines = [line.strip() for line in raw.splitlines()]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _html_to_text(html: str) -> str:
    """Reduce an HTML document to readable plain text using only the stdlib."""
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        # Malformed markup: fall back to a crude tag strip rather than failing.
        return re.sub(r"\s{2,}", " ", unescape(re.sub(r"<[^>]+>", " ", html))).strip()
    return parser.get_text()


def _normalize_url(trial_url: str) -> str:
    """Trim the URL and default it to https:// when no scheme was supplied."""
    normalized = trial_url.strip()
    if not normalized:
        raise ValueError("Empty trial_url.")
    if not normalized.lower().startswith(("http://", "https://")):
        normalized = "https://" + normalized
    return normalized


_MD_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!><=^~|])")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean_registry_text(text: str) -> str:
    """
    Strip markdown escaping from registry prose before it reaches the model.

    ClinicalTrials.gov returns criteria markdown-escaped: `\\>= 1,500/mcL`,
    `obtained =\\< 14 days`, `1,500/mm\\^3`. Those backslashes carry no clinical
    meaning, and weaker models mangle them badly: one emitted a literal control
    character plus "60;" where the source said `\\>=`, so the UI rendered
    "Absolute neutrophil count 60; 1,500/mcL". Normalising here fixes the display
    AND removes a needless obstacle from the comparison the model has to make.
    """
    if not text:
        return text
    out = _MD_ESCAPE.sub(r"\1", text)
    # Normalise to PLAIN ASCII, not the typographic glyphs. Tempting as "≥" is,
    # weaker models cannot reliably emit U+2265 inside a JSON string: gpt-4.1-mini
    # produced the literal bytes `\\u000260;` for it, which rendered in the UI as
    # "neutrophil count 60; 1,500/mcL". ">=" survives every model and every JSON
    # round trip, and a clinician reads it identically.
    out = out.replace("\u2265", ">=").replace("\u2264", "<=")
    out = re.sub(r"=<(?!=)", "<=", out)
    out = re.sub(r"=>(?!=)", ">=", out)
    return out


# Residue of a model failing to encode an inequality glyph, e.g. `\x0260;` for ">=".
_MANGLED_GLYPH = re.compile(r"[\x00-\x1f]\s*6[02];")


def _strip_control_chars(value: str) -> str:
    """
    Clean stray control characters a model may emit inside a string field.

    Repairs the known mangled-inequality pattern first, so the text degrades to
    ">=" rather than to a stray "60;" that reads as a number in a clinical value.
    """
    if not isinstance(value, str):
        return value
    return _CTRL.sub("", _MANGLED_GLYPH.sub(">=", value))


def _fetch_ctgov_criteria(nct_id: str) -> str:
    """
    Pull eligibility criteria from the official ClinicalTrials.gov API v2.

    Public and unauthenticated. Returns the criteria already structured, so the model
    reads the actual protocol text instead of page chrome: no scraping involved.

    RETRIED ON THROTTLING AND SERVER FAULTS. Discovery fans out at
    DISCOVERY_CONCURRENCY, so several of these fire at once and the registry
    answers some of them with a 429. There was no retry, so a single throttled
    response dropped the trial for the whole run: a measured discovery lost two
    of four studies this way, and re-fetching the same three ids by hand
    seconds later returned all three.

    Cheap to retry, unlike a model call — the registry is free and fast, so the
    only cost of another attempt is a short wait.
    """
    url = CTGOV_API_TEMPLATE.format(nct_id=nct_id.upper())
    response = None

    for attempt in range(3):
        response = requests.get(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=FETCH_TIMEOUT_SECONDS,
        )
        # A 404 is a real answer: that study does not exist, and asking again
        # will not change it. Only throttling and server faults are transient.
        if response.status_code != 429 and response.status_code < 500:
            break
        if attempt < 2:
            wait = 0.0
            try:
                wait = float(response.headers.get("Retry-After", "") or 0)
            except ValueError:
                wait = 0.0
            # Backoff grows so concurrent callers stop colliding on the retry.
            time.sleep(min(max(wait, 1.5 * (attempt + 1)), 8.0))

    response.raise_for_status()
    protocol = (response.json() or {}).get("protocolSection", {}) or {}

    ident = protocol.get("identificationModule", {}) or {}
    design = protocol.get("designModule", {}) or {}
    elig = protocol.get("eligibilityModule", {}) or {}

    criteria = (elig.get("eligibilityCriteria") or "").strip()
    if not criteria:
        raise ValueError(f"{nct_id} returned no eligibility criteria.")

    # Assemble the surrounding constraints the criteria text usually omits.
    lines = [
        f"Protocol {ident.get('nctId', nct_id)}: {ident.get('briefTitle', '')}".strip(),
    ]
    if official := (ident.get("officialTitle") or "").strip():
        lines.append(f"Official Title: {official}")
    if phases := design.get("phases"):
        lines.append(f"Phase: {', '.join(phases)}")
    if (sex := elig.get("sex")) and sex != "ALL":
        lines.append(f"Eligible Sex: {sex}")
    if minimum := (elig.get("minimumAge") or "").strip():
        lines.append(f"Minimum Age: {minimum}")
    if maximum := (elig.get("maximumAge") or "").strip():
        lines.append(f"Maximum Age: {maximum}")
    if elig.get("healthyVolunteers") is not None:
        lines.append(f"Accepts Healthy Volunteers: {bool(elig['healthyVolunteers'])}")

    lines.append("")
    lines.append("Eligibility Constraints:")
    lines.append(criteria)
    return _clean_registry_text("\n".join(lines).strip())


def _fetch_generic_page_text(url: str) -> str:
    """
    Fetch an arbitrary page and reduce it to plain text with the stdlib parser.

    The host is checked first: this is the one place a caller-supplied URL causes
    this process to open a connection. See `_assert_fetchable_url`.
    """
    _assert_fetchable_url(url)
    response = requests.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        },
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    body = response.text or ""
    content_type = (response.headers.get("Content-Type") or "").lower()
    if "html" in content_type or "<html" in body[:2048].lower():
        return _clean_registry_text(_html_to_text(body))
    return _clean_registry_text(body.strip())


CTGOV_SEARCH_URL = "https://clinicaltrials.gov/api/v2/studies"


# Qualifiers that describe a patient's disease but are not part of the condition
# NAME the registry indexes on. "Stage IV KRAS G12C-mutated NSCLC" is how a
# clinician describes a case; "non-small cell lung carcinoma" is how the registry
# files it.
_STAGE_NOISE = re.compile(
    r"\b(stage\s+[0-9IVX]+|metastatic|advanced|recurrent|refractory|relapsed"
    r"|unresectable|newly diagnosed|primary|treatment-naive)\b",
    re.IGNORECASE,
)
# "KRAS G12C", "KRAS G12C-mutated", "EGFR-positive", "ALK-negative".
_MUTATION_NOISE = re.compile(
    r"\b[A-Z][A-Z0-9]{1,6}\s+[A-Z][0-9]{1,4}[A-Z]?(-mutated|-mutant)?\b"
    r"|\b[A-Z][A-Z0-9]{1,6}-(mutated|mutant|positive|negative)\b"
)
# Anatomical detail: "osteosarcoma OF THE DISTAL FEMUR" is filed as "osteosarcoma".
_SITE_NOISE = re.compile(r"\s+of\s+(the\s+)?[a-z].*$", re.IGNORECASE)


def _condition_ladder(condition: str) -> List[str]:
    """
    Progressively broader forms of a condition, most specific first.

    Measured against the live registry, a clinically precise condition returns
    almost nothing — the index matches on disease names, not case descriptions:

        'non-small cell lung cancer'                          -> 12 studies
        'stage IV KRAS G12C-mutated non-small cell lung ca…'  ->  3
        'metastatic non-small cell lung carcinoma, adenoca…'  ->  0
        'newly diagnosed osteosarcoma of the distal femur'    ->  0

    A zero-result search is not a patient with no options; it is a query the
    registry could not parse. Each rung drops one class of qualifier, so the
    specific form is still tried first and only widens when it comes up short.
    """
    seen: set = set()
    ladder: List[str] = []

    def add(text: str) -> None:
        cleaned = re.sub(r"\s{2,}", " ", text).strip(" ,-")
        if cleaned and cleaned.lower() not in seen:
            seen.add(cleaned.lower())
            ladder.append(cleaned)

    add(condition)
    # A trailing clause after a comma ("..., adenocarcinoma subtype") is the single
    # most reliable way to get zero results.
    head = condition.split(",")[0]
    add(head)
    stripped = _STAGE_NOISE.sub("", _MUTATION_NOISE.sub("", head))
    add(stripped)
    add(_SITE_NOISE.sub("", stripped))
    return ladder


# Below this, the shortlist is too thin to rank and the query is probably the
# reason. Not 1: a genuinely rare condition can legitimately have very few open
# trials, and broadening past a real answer would bury it in generic studies.
_MIN_SHORTLIST = 3


def _search_recruiting_trials(
    condition: str,
    location: str = "",
    page_size: int = 12,
    keywords: Optional[List[str]] = None,
) -> tuple[List[Dict[str, Any]], bool]:
    """
    Find currently-recruiting trials for a condition, optionally near a location.

    Only RECRUITING studies are returned; a perfectly matching but closed trial is
    noise to a clinician looking for somewhere to send a patient today.

    Walks `_condition_ladder` until a search returns enough studies to rank. The
    first rung is the model's own phrasing, so a precise condition that DOES match
    still wins; the rest exist so an over-specific one degrades to a broader search
    instead of to an empty page.
    """
    # The model is asked for "biomarkers, mutations, stage" and returns them in
    # `keywords`. They were derived on every run and then thrown away, so a Stage
    # IV KRAS G12C patient was screened against whatever the registry returns for
    # "non-small cell lung cancer" — carbon-ion therapy, an ALK cognition study,
    # a neoadjuvant stage III trial. The verdicts on those are correctly BLOCKED,
    # which makes the failure invisible: a page of confident, useless rejections.
    #
    # As query.term they change the shortlist completely, to KRAS-targeted and
    # advanced/metastatic studies. query.term rather than query.cond because
    # these are free-text qualifiers, and folding them into the condition is what
    # produced the zero-result searches _condition_ladder exists to undo.
    focus = " ".join(k.strip() for k in (keywords or []) if k.strip())[:180]

    def run(term: str, near: str, focus_terms: str) -> List[Dict[str, Any]]:
        params: List[tuple] = [
            ("query.cond", term),
            ("filter.overallStatus", "RECRUITING"),
            ("pageSize", str(page_size)),
        ]
        if focus_terms:
            params.append(("query.term", focus_terms))
        # `near`, not `location`: the widening pass calls this with "" and a
        # closure over the outer argument would have quietly kept the filter on,
        # making the retry identical to the search that just failed.
        if near.strip():
            params.append(("query.locn", near.strip()))

        # Retried on throttling and server faults, exactly as the criteria fetch
        # is. A registry 500 here used to end the entire run before a single
        # trial was scored — and the query it blamed was fine: re-issued
        # moments later it returned 200. The registry is free and fast, so
        # another attempt costs nothing but a short wait, while the failure it
        # prevents costs the user their whole run.
        response = None
        for attempt in range(3):
            response = requests.get(
                CTGOV_SEARCH_URL,
                params=params,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=FETCH_TIMEOUT_SECONDS,
            )
            if response.status_code != 429 and response.status_code < 500:
                break
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))

        response.raise_for_status()
        return (response.json() or {}).get("studies", []) or []

    def walk(near: str, focus_terms: str = "") -> List[Dict[str, Any]]:
        best: List[Dict[str, Any]] = []
        for term in _condition_ladder(condition):
            studies = run(term, near, focus_terms)
            if len(studies) > len(best):
                best = studies
            if len(studies) >= _MIN_SHORTLIST:
                if term != condition:
                    # Say so: the condition shown in the UI came from the record,
                    # and a silently different search is how a clinician ends up
                    # trusting a shortlist that answered a question they did not ask.
                    log.info(
                        "phase     search broadened <%d chars> -> <%d chars>, %d studies",
                        len(condition),
                        len(term),
                        len(studies),
                    )
                return studies
        return best

    # Sharpest first: the record's own biomarkers and stage, at the location asked
    # for. Each fallback below drops exactly one constraint, most expendable first,
    # so the shortlist degrades in a defensible order rather than all at once.
    def merge(primary, secondary):
        """Primary first, then whatever secondary adds. Deduped on NCT id."""
        out = list(primary)
        seen = {
            s.get("protocolSection", {})
            .get("identificationModule", {})
            .get("nctId")
            for s in out
        }
        for study in secondary:
            nct = (
                study.get("protocolSection", {})
                .get("identificationModule", {})
                .get("nctId")
            )
            if nct and nct not in seen:
                seen.add(nct)
                out.append(study)
        return out[:page_size]

    studies = walk(location, focus)

    # A biomarker-selected search is precise and often SHORT — four keywords on
    # NSCLC returned two studies where the plain condition returned eight. Letting
    # the targeted list stand alone was tried and is worse for two reasons.
    #
    # It made the shortlist size depend on what the model happened to extract:
    # a run whose keywords matched screened two trials, an identical run whose
    # keywords missed screened four. Same patient, same condition, different
    # amount of work done, for no reason the user can see.
    #
    # And a short list is not the same as a good one. The targeted studies are
    # the ones worth ranking first, but the general pool is still what the
    # patient might qualify for, and a clinician deciding where to send someone
    # would rather scan four than two.
    #
    # So the general search TOPS UP rather than replaces: targeted studies keep
    # the leading ranks, the rest fills behind them, and the shortlist is the
    # same size every run.
    if focus and len(studies) < page_size:
        studies = merge(studies, walk(location))

    if studies or not location.strip():
        return studies, False

    # The location filter alone can empty a search that would otherwise be full.
    # Measured: 'invasive ductal carcinoma' returns 12 studies unfiltered, 2 for
    # "Ohio" and ZERO for "Cleveland, OH" — the registry matches location text
    # strictly, so a city with no registered site reads as a patient with no
    # options. Dropping the filter is better than an empty page, because
    # _summarize_study still orders each trial's sites by distance from `near`,
    # so the nearest site is what the clinician sees first either way.
    #
    # The caller is told, and the UI says so. A shortlist silently answering
    # "anywhere" when the clinician asked "near me" would be the worse bug.
    # Last resort: keywords first, then bare condition, both nationally.
    widened = walk("", focus) or walk("")
    if widened:
        log.info(
            "phase     location filter dropped, %d studies found nationally",
            len(widened),
        )
    return widened, bool(widened)


def _summarize_study(study: Dict[str, Any], near: str = "") -> Dict[str, Any]:
    """
    Flatten a registry study record into the fields the UI needs.

    Locations are ordered by relevance to `near`. Registry order is effectively
    alphabetical, so showing the first few sites for a San Jose search surfaced
    "Anchorage, Alaska": technically true and completely useless to the clinician.
    """
    protocol = study.get("protocolSection", {}) or {}
    ident = protocol.get("identificationModule", {}) or {}
    design = protocol.get("designModule", {}) or {}
    status = protocol.get("statusModule", {}) or {}
    contacts = protocol.get("contactsLocationsModule", {}) or {}

    # Match on any comma-separated part of the query, so "Tokyo, Japan",
    # "Japan" and "California" all hit.
    #
    # WORD-BOUNDARY, NOT SUBSTRING. A plain `needle in haystack` test treats a
    # two-letter state abbreviation as a wildcard: searching "Cleveland, OH"
    # matched "J-OH-annesburg", "C-oh-asset" and "R-oh-nert Park", and because
    # matches sort first, Johannesburg outranked Cleveland, Ohio for a search
    # naming Cleveland. Every US state has a two-letter form, so this fired on
    # the most ordinary input the field accepts.
    # Anchored at the START of a word, open at the end. A trailing boundary too
    # would drop the abbreviation itself — "OH" would stop matching "Ohio" — and
    # a prefix is what a place name actually shares ("Calif" for "California").
    needles = [
        re.compile(rf"\b{re.escape(p.strip().lower())}")
        for p in near.split(",")
        if p.strip()
    ]

    # The true number of participating sites, taken before any slicing or
    # deduplication. Counting the labels instead undercounted twice over: the list
    # is capped at 120 entries for display, and several sites in one city collapse
    # to a single label, so a 300-site study reported "+3 more sites".
    all_locations = contacts.get("locations") or []
    site_count = len(all_locations)

    # SCAN EVERY SITE, cap only what is DISPLAYED.
    #
    # This iterated `all_locations[:120]`, which applied the display cap before
    # the relevance sort — so on a 372-site study the search never looked past
    # the first 120 entries. A search for "Tokyo, Japan" against a trial with
    # twenty Japanese sites showed "Fullerton, California · Golden, Colorado",
    # because every Japanese site sat beyond the slice. The one thing the
    # clinician needs to know — that this study is reachable — was the thing the
    # cap removed.
    #
    # `others` is still bounded, because it is only ever used to pad the display
    # and a full 372-entry list of irrelevant cities helps nobody.
    nearby: List[str] = []
    nearby_open: List[str] = []
    others: List[str] = []
    for loc in all_locations:
        city = (loc.get("city") or "").strip()
        state = (loc.get("state") or "").strip()
        country = (loc.get("country") or "").strip()

        # Registry data is US-centric in shape: every site has city/state, and the
        # country is what actually disambiguates abroad. Showing "Nice,
        # Alpes-Maritimes" tells a user nothing; "Nice, France" does. US sites keep
        # the state because that is the familiar form there.
        if country and country != "United States":
            label = ", ".join(p for p in (city, country) if p)
        else:
            label = ", ".join(p for p in (city, state) if p)
        if not label:
            continue

        # Match against every component, including the ones not displayed, so a
        # search for a département or a US state still resolves.
        haystack = " ".join(p for p in (city, state, country) if p).lower()
        if any(n.search(haystack) for n in needles):
            # A site that is near but NOT YET RECRUITING cannot be walked into
            # today, so an open one outranks it. Both are kept — a site opening
            # soon is still worth a clinician knowing about.
            bucket = (
                nearby_open
                if (loc.get("status") or "").upper() == "RECRUITING"
                else nearby
            )
        elif len(others) < 120:
            bucket = others
        else:
            continue
        if label not in bucket:
            bucket.append(label)

    near_all = nearby_open + [n for n in nearby if n not in nearby_open]
    ordered = near_all + [o for o in others if o not in near_all]
    nct = ident.get("nctId", "")
    return {
        "nct_id": nct,
        "title": ident.get("briefTitle", "") or ident.get("officialTitle", ""),
        "phase": ", ".join(design.get("phases", []) or []) or "N/A",
        "status": status.get("overallStatus", "") or "",
        "url": f"https://clinicaltrials.gov/study/{nct}",
        "locations": ordered[:6],
        "site_count": site_count,
        # BOTH buckets. Splitting nearby sites into open and not-yet-open left
        # this counting only the second, so a trial whose every local site was
        # actively recruiting reported "0 nearby" — the exact opposite of the
        # truth, and only in the good case.
        "nearby_count": len(nearby_open) + len(nearby),
    }


def _score_matrix(nodes: List[ComplianceNode]) -> Dict[str, Any]:
    """
    Turn a compliance matrix into a ranking score, a verdict, and a distance summary.

    Ranking is by *how close the patient is to enrolling*, not pass/fail. Most
    patients are a near-miss on something, and "2 labs away" is far more useful to a
    coordinator than a binary no.

    A single CONFLICT is still disqualifying: eligibility is not a majority vote,
    so blocked trials sort below every unblocked one regardless of how many criteria
    they otherwise satisfy. Within each band, fewer open items ranks higher.

    AN EMPTY MATRIX IS NOT A PASS. The arithmetic below reads "no conflicts and no
    unknowns" off an empty list and concludes LIKELY_ELIGIBLE at score 1.0 with the
    label "All criteria met" — the most confident verdict this tool can produce,
    resting on nothing, sorted to the top of the ranking. A model that returns an
    empty compliance_matrix still satisfies the schema, so this was reachable from
    one bad response. Zero criteria means the trial was not screened, and it is
    reported that way.
    """
    if not nodes:
        return {
            "verdict": "NEEDS_DATA",
            "score": 0.0,
            "match_count": 0,
            "conflict_count": 0,
            "unknown_count": 0,
            "blockers": 0,
            "open_items": 0,
            "distance_label": "No criteria were scored",
        }

    match = sum(1 for n in nodes if n.status == "MATCH")
    conflict = sum(1 for n in nodes if n.status == "CONFLICT")
    unknown = sum(1 for n in nodes if n.status == "UNKNOWN")
    total = max(len(nodes), 1)

    # How many discrete things stand between this patient and enrolment.
    blockers = conflict
    open_items = unknown

    if conflict:
        verdict = "BLOCKED"
        # Ordered among themselves by how many blockers and how much else fits.
        score = max(0.0, 0.30 - 0.06 * conflict + 0.10 * (match / total))
    elif unknown:
        verdict = "NEEDS_DATA"
        # Fewer outstanding questions ranks higher; a trial needing one lab beats
        # one needing five even if both are otherwise identical.
        score = 0.55 + 0.40 * (match / total) - 0.03 * min(unknown, 8)
    else:
        verdict = "LIKELY_ELIGIBLE"
        score = 1.0

    if conflict:
        distance = (
            f"{conflict} blocking exclusion{'s' if conflict != 1 else ''}"
            + (f", {unknown} unresolved" if unknown else "")
        )
    elif unknown:
        distance = f"{unknown} item{'s' if unknown != 1 else ''} to confirm"
    else:
        distance = "All criteria met"

    return {
        "verdict": verdict,
        "score": round(max(0.0, min(score, 1.0)), 4),
        "match_count": match,
        "conflict_count": conflict,
        "unknown_count": unknown,
        "blockers": blockers,
        "open_items": open_items,
        "distance_label": distance,
    }


# The compliance-matrix contract in SYSTEM_MESSAGE is wrong for this call, which
# wants two fields and no matrix. Sending it anyway made the system and user
# messages contradict each other.
SEARCH_TERMS_SYSTEM_MESSAGE = (
    "You are a clinical research assistant that replies with JSON only. "
    'Return a single JSON object with exactly these keys: "condition" (a string) '
    'and "keywords" (an array of strings). '
    "Emit no markdown fences and no commentary outside the JSON object."
)


def _derive_search_terms(patient_text: str) -> SearchTerms:
    """Ask the model for the registry search condition implied by the record."""
    prompt = (
        "From the de-identified clinical record below, identify the single primary "
        "condition to search a clinical trial registry for, plus up to 4 supporting "
        "keywords (biomarkers, mutations, stage).\n\n"
        'Reply with JSON only: {"condition": "...", "keywords": ["...", "..."]}\n'
        'Use the common registry phrasing for "condition" (for example '
        '"non-small cell lung cancer", not "NSCLC adenocarcinoma stage IV").\n\n'
        # `_fit_record`, not `[:8000]`. This is the same defect that was fixed in
        # the scoring path and missed here: a plain prefix keeps the opening of
        # the chart, and on a long record the diagnosis can sit past it. Deriving
        # the search condition from the wrong half means every trial that follows
        # is the wrong shortlist — a failure that looks like a bad model rather
        # than a bad slice.
        f"RECORD:\n{_fit_record(patient_text, 8000)}"
    )
    raw = _generate_structured_payload(prompt, system=SEARCH_TERMS_SYSTEM_MESSAGE)
    return SearchTerms.model_validate(_coerce_json(raw))


def _fetch_trial_text(trial_url: str) -> str:
    """
    Resolve a trial URL to plain criteria text.

    Registry URLs (anything containing an NCT id) go to the ClinicalTrials.gov API v2;
    everything else is fetched directly and converted to text locally. No third-party
    scraping service and no API key is involved on either path.
    """
    normalized = _normalize_url(trial_url)

    match = NCT_ID_PATTERN.search(normalized)
    if match:
        return _fetch_ctgov_criteria(match.group(1))

    return _fetch_generic_page_text(normalized)


SYSTEM_MESSAGE = (
    "You are a clinical research assistant that replies with JSON only. "
    "Return a single JSON object with exactly these top-level keys:\n"
    '  "patient_summary": array of objects with keys '
    '"category", "metric_name", "extracted_value"\n'
    '  "compliance_matrix": array of objects with keys '
    '"id", "category", "patient_fact", "trial_rule", "status", "explanation", '
    '"record_quote", "criterion_quote", "data_needed"\n'
    '"category" in patient_summary must be one of: GENETICS, LAB_VALUES, '
    "COMORBIDITIES, DEMOGRAPHICS, MEDICATIONS.\n"
    '"status" must be one of: MATCH, CONFLICT, UNKNOWN.\n'
    '"id" must be a string like "node_1", "node_2", incrementing.\n'
    '"record_quote" and "criterion_quote" must be VERBATIM copies from the source '
    "texts, never paraphrases, because they are highlighted in the originals.\n"
    '"data_needed" is required for UNKNOWN entries (an actionable order) and an '
    "empty string otherwise.\n"
    "Emit no markdown fences and no commentary outside the JSON object."
)


def _extract_provider_error(response: "requests.Response") -> str:
    """Pull the provider's own error message out of a non-200 response."""
    detail = response.text[:400]
    try:
        body = response.json()
        err = body.get("error")
        if isinstance(err, dict):
            return err.get("message", detail)
        if isinstance(err, str):
            return err
        if isinstance(body.get("message"), str):
            return body["message"]
    except Exception:
        pass
    return detail


def _generate_structured_payload(prompt: str, system: str = SYSTEM_MESSAGE) -> str:
    """
    Produce the raw JSON string for one analysis, trying each configured provider.

    Walks `_provider_chain()` in order and returns the first success. A provider is
    only skipped after it actually fails, so the primary is always preferred and a
    fallback costs nothing when nothing is wrong.

    `system` is a parameter because not every caller wants the compliance-matrix
    contract. It used to be hardcoded, which left `_derive_search_terms` asking for
    {"condition", "keywords"} while the system message above it demanded
    patient_summary and compliance_matrix — a direct contradiction the model had to
    resolve on its own every time, and one that only stayed resolved in our favour
    by luck of which model was configured.

    If every provider fails, the error names each one and what it said, because "the
    LLM analysis call failed" with three providers configured is not a diagnosable
    message.
    """
    chain = _provider_chain()
    errors: List[str] = []

    for provider in chain:
        started = time.monotonic()
        try:
            result = _call_one_provider(provider, prompt, system)
            log.info(
                "llm ok    %-9s %-42s %6.1fs  in~%dtok",
                provider["name"],
                provider["model"][:42],
                time.monotonic() - started,
                len(prompt) // 4,
            )
            return result
        except Exception as exc:
            log.info(
                "llm FAIL  %-9s %-42s %6.1fs  %s",
                provider["name"],
                provider["model"][:42],
                time.monotonic() - started,
                _safe_error(exc),
            )
            errors.append(f"{provider['name']}: {exc}")
            continue

    if len(errors) == 1:
        # Single provider configured: surface its error verbatim, unchanged from
        # the pre-fallback behaviour so existing messages stay recognisable.
        raise RuntimeError(errors[0].split(": ", 1)[1])
    raise RuntimeError(
        f"All {len(chain)} configured providers failed — " + " | ".join(errors)
    )


def _call_one_provider(
    provider: Dict[str, str], prompt: str, system: str = SYSTEM_MESSAGE
) -> str:
    """
    Call one LLM provider and return the raw JSON string it produced.

    Works against any OpenAI-compatible chat-completions endpoint (Groq, OpenAI,
    OpenRouter, Together, Cerebras, DeepSeek, Ollama, ...) with a plain `requests`
    POST: no vendor SDK. Anthropic uses a different wire format and is branched.

    temperature=0.1: strict medical accuracy is worth far more than creative variance.

    NOTE ON SCHEMA ENFORCEMENT: `json_object` mode guarantees syntactically valid JSON
    but does NOT enforce our field structure the way a server-side response schema
    would. The shape is pinned two other ways: it is stated explicitly in the system
    message, and every response is validated against `ClinixPathPayload` by the caller,
    which returns a 502 rather than passing a malformed matrix to the frontend.
    """
    api_key = _key_for(provider)
    if not api_key:
        raise RuntimeError(f"{provider['key_env']} is not configured.")

    if provider["name"] == "anthropic":
        response = requests.post(
            f"{provider['base_url']}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            json={
                "model": provider["model"],
                # Was hardcoded 8192 while every other provider honoured its own
                # `max_output_tokens`, so tuning that key did nothing here.
                "max_tokens": int(
                    provider.get("max_output_tokens") or LLM_MAX_OUTPUT_TOKENS
                ),
                "temperature": 0.1,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=LLM_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"{provider['name']} returned HTTP {response.status_code}: "
                f"{_extract_provider_error(response)}"
            )
        try:
            body = response.json()
            raw_text = "".join(
                block.get("text", "")
                for block in body.get("content", [])
                if block.get("type") == "text"
            )
        except (ValueError, AttributeError, TypeError) as exc:
            raise RuntimeError(f"Unexpected anthropic response shape: {exc}") from exc

        # Same defect as the OpenAI branch below, different spelling of the field.
        if body.get("stop_reason") == "max_tokens":
            raise RuntimeError("anthropic truncated its response at the token ceiling.")
    else:
        payload: Dict[str, Any] = {
            "model": provider["model"],
            "temperature": 0.1,
            # Explicit, because provider defaults are not survivable: Cloudflare's
            # is 256 tokens, which a reasoning model spends entirely on its trace.
            # Per-provider, because the same weights behave differently on
            # different serving stacks — see the notes in LLM_PRESETS.
            "max_tokens": int(
                provider.get("max_output_tokens") or LLM_MAX_OUTPUT_TOKENS
            ),
            # gpt-oss and other reasoning models honour this; gateways that do
            # not know it ignore it, and the 400-retry below strips it if one
            # objects.
            "reasoning_effort": provider.get("reasoning_effort")
            or LLM_REASONING_EFFORT,
            "response_format": {"type": "json_object"},
            # Most current open-weight models are reasoning models, and they emit
            # their chain-of-thought into `content` ahead of the answer. That is
            # fatal here: _coerce_json tolerates a ```json fence but not a
            # paragraph of "Okay, the user is asking me to...", so the parse dies
            # on the first character and the run 502s. Suppressing the trace also
            # stops thousands of thinking tokens burning the free-tier budget.
            # Gateways that do not know this key ignore it.
            "reasoning": {"exclude": True},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        }

        # Parameters this provider is KNOWN to reject. The retry below is the
        # safety net for providers we have not characterised; this is the fast
        # path for the ones we have, so a known incompatibility costs zero
        # round-trips instead of one per call.
        for key in (provider.get("unsupported") or "").split():
            payload.pop(key, None)

        # Size the output reservation to the budget that is actually left.
        #
        # Groq charges prompt + max_tokens against its per-minute ceiling AT
        # REQUEST TIME, so a flat reservation is spent whether or not the model
        # needs it. Asking for 5,000 on top of a ~2,300-token fixed prompt left
        # almost nothing for the record and produced a 413 on inputs as small as
        # 1,360 characters — the fast provider rejecting the work rather than
        # doing it. Asking for what remains means small records are served here
        # (which is the point of a fast primary) and only genuinely large ones
        # fall through to a provider with room.
        if tpm := provider.get("tpm_limit"):
            # ~4 chars per token, deliberately pessimistic, plus headroom for the
            # envelope. Over-estimating costs a little output budget; under-
            # estimating costs the whole call.
            estimated_prompt = (len(prompt) + len(system)) // 4 + 200
            remaining = int(tpm) - estimated_prompt
            if remaining < _MIN_USEFUL_OUTPUT_TOKENS:
                # Not enough room for an answer worth having. Raising here rather
                # than sending it means the chain advances immediately instead of
                # spending a round-trip to be told the same thing.
                raise RuntimeError(
                    f"{provider['name']} has no room for this request: "
                    f"~{estimated_prompt} prompt tokens against a {tpm} TPM limit."
                )
            payload["max_tokens"] = min(payload["max_tokens"], remaining)

        response = requests.post(
            f"{provider['base_url']}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            json=payload,
            timeout=LLM_TIMEOUT_SECONDS,
        )

        # Not every OpenAI-compatible server supports every optional parameter.
        # If one is named in a 4xx, drop it and retry — the shape is still held by
        # the system message and by Pydantic validation on the way out.
        #
        # Generalised from a response_format-only check because the payload now
        # carries `reasoning`, `reasoning_effort` and `max_tokens` too, and a
        # provider rejecting any of those used to fail the whole call outright.
        # Defined unconditionally: the guard below reads it on every path, and
        # scoping it inside the 4xx branch made a successful call raise NameError.
        dropped: List[str] = []
        if response.status_code >= 400:
            body_text = response.text
            # `max_tokens` is deliberately NOT in this list even though the
            # comment above once claimed it was: dropping it would hand the
            # request back to the provider's default, and Cloudflare's default
            # of 256 is the exact failure this file exists to remember.
            dropped = [
                key
                for key in ("response_format", "reasoning_effort", "reasoning")
                if key in body_text and key in payload
            ]
            for key in dropped:
                payload.pop(key, None)
        # Only worth a second call if something actually changed. Retrying an
        # unmodified payload just spends quota to receive the same 400 twice.
        if response.status_code >= 400 and dropped:
            response = requests.post(
                f"{provider['base_url']}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                json=payload,
                timeout=LLM_TIMEOUT_SECONDS,
            )

        if response.status_code == 429:
            # Free tiers throttle hard. Honour Retry-After when given, otherwise a
            # short fixed pause, then try once more before giving up.
            wait = 0.0
            try:
                wait = float(response.headers.get("Retry-After", "") or 0)
            except ValueError:
                wait = 0.0
            time.sleep(min(max(wait, 3.0), 20.0))
            response = requests.post(
                f"{provider['base_url']}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                json=payload,
                timeout=LLM_TIMEOUT_SECONDS,
            )

        if response.status_code == 429:
            # Report the ACTUAL reset window. Free tiers layer a per-DAY cap on top
            # of per-minute burst limits, and a message saying "wait a few minutes"
            # when the real answer is six hours sends people in circles. The header
            # tells us which one we hit.
            kind = response.headers.get("x-ratelimit-type", "")
            secs = 0
            try:
                secs = int(float(response.headers.get("retry-after", "0") or 0))
            except ValueError:
                secs = 0
            if secs >= 3600:
                when = f"about {secs // 3600}h {(secs % 3600) // 60}m"
            elif secs >= 60:
                when = f"about {secs // 60} minutes"
            elif secs:
                when = f"about {secs} seconds"
            else:
                when = "an unknown period"
            daily = "day" in kind.lower()
            # Names the providers actually configured. The previous text listed
            # GitHub Models IDs (gpt-4.1-mini, mistral-small-2503) left over from
            # an earlier provider, so it advised setting LLM_MODEL to models that
            # do not exist on Groq or Cloudflare — advice that cannot work is
            # worse than no advice.
            others = [p for p in LLM_PRESETS if p != provider["name"]]
            hint = (
                "This is a per-model daily cap, so a different model or provider "
                "gives a fresh allowance immediately. Configured fallbacks: "
                f"{', '.join(others[:3])}. Set LLM_PROVIDER in backend/.env."
                if daily
                else "Retry shortly, or set LLM_PROVIDER in backend/.env to a "
                "provider with a separate bucket."
            )
            raise RuntimeError(
                f"{provider['name']} rate limit reached (HTTP 429"
                f"{', ' + kind if kind else ''}). Resets in {when}. {hint}"
            )

        if response.status_code != 200:
            raise RuntimeError(
                f"{provider['name']} returned HTTP {response.status_code}: "
                f"{_extract_provider_error(response)}"
            )
        try:
            choice = response.json()["choices"][0]
            raw_text = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(
                f"Unexpected {provider['name']} response shape: {exc}"
            ) from exc

        # A response cut off at the token ceiling is HTTP 200 with well-formed
        # envelope and half a JSON object inside it. Without this check it counted
        # as a SUCCESS: the provider loop stopped, the truncated text went back to
        # the caller, and _coerce_json died there — so the run failed outright
        # instead of failing over to a provider with a larger budget.
        #
        # Not hypothetical. Groq's ceiling is 5,000 (forced by its 8,000 TPM,
        # charged on prompt + max_tokens), and a measured analysis run spent 4,816
        # of them. Cloudflare allows 8,192, so this raise is what routes the
        # overflow to a provider that can actually finish the answer.
        if choice.get("finish_reason") == "length":
            raise RuntimeError(
                f"{provider['name']} truncated its response at the "
                f"{payload['max_tokens']}-token ceiling."
            )

    if not raw_text or not raw_text.strip():
        raise RuntimeError(f"{provider['name']} returned an empty response body.")
    return raw_text.strip()


def _scrub_strings(node: Any) -> Any:
    """Recursively strip control characters from every string in a parsed payload."""
    if isinstance(node, str):
        return _strip_control_chars(node)
    if isinstance(node, list):
        return [_scrub_strings(v) for v in node]
    if isinstance(node, dict):
        return {k: _scrub_strings(v) for k, v in node.items()}
    return node


def _coerce_json(raw_text: str) -> Any:
    """
    Parse model output as JSON, tolerating the two ways models wrap it.

    A ```json fence is handled first. What remains is a PREAMBLE: "Here is the
    analysis:" or a paragraph of reasoning ahead of the object. `reasoning:
    {"exclude": True}` suppresses that on gateways that understand the key, but the
    fallback chain exists precisely so a run can land on a provider that does not,
    and a preamble is the most likely thing an unfamiliar model does. Losing the
    whole analysis to a conversational opener is not a reasonable failure, so the
    outermost {...} is recovered before giving up.
    """
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
        text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Widest span between the first { and the last }. Not a JSON parser: it is
        # a way to drop prose on either side and hand the result to the real one,
        # which still rejects anything genuinely malformed.
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])

    # Belt and braces: a weaker model can emit a stray control byte mid-string,
    # which renders as visible garbage ("\x0260;") in the UI.
    return _scrub_strings(parsed)


# ---------------------------------------------------------------------------
# 3. ROUTES
# ---------------------------------------------------------------------------


@app.get("/", response_model=HealthResponse)
async def root() -> HealthResponse:
    """Root liveness probe."""
    # A liveness probe must answer even when the LLM is misconfigured — that is
    # precisely when someone is checking it. A config error is reported as a
    # field, never as a 500.
    try:
        provider = _active_provider()
    except RuntimeError as exc:
        return HealthResponse(llm_provider="misconfigured", llm_model=str(exc)[:200])
    return HealthResponse(
        llm_provider=provider["name"],
        llm_model=provider["model"],
        llm_api_key_configured=get_api_key() is not None,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health probe. Reports only whether a key is configured: never its value."""
    # A liveness probe must answer even when the LLM is misconfigured — that is
    # precisely when someone is checking it. A config error is reported as a
    # field, never as a 500.
    try:
        provider = _active_provider()
    except RuntimeError as exc:
        return HealthResponse(llm_provider="misconfigured", llm_model=str(exc)[:200])
    return HealthResponse(
        llm_provider=provider["name"],
        llm_model=provider["model"],
        llm_api_key_configured=get_api_key() is not None,
    )


_SUMMARY_CATEGORIES = {
    "GENETICS",
    "LAB_VALUES",
    "COMORBIDITIES",
    "DEMOGRAPHICS",
    "MEDICATIONS",
}


def _merge_patient_summaries(
    candidates: List[TrialCandidate],
) -> List[ExtractedMetric]:
    """
    One patient snapshot out of every trial that was scored.

    Candidates arrive ranked, so the best-fitting trial's reading of the record
    leads and the rest fill in what it did not ask about.

    Falls back to the compliance matrices when no trial returned a summary, so a
    model that answers with an empty `patient_summary` degrades to a thinner panel
    rather than an empty one. The fallback cannot invent a metric name it was never
    given, so it names the criterion the fact was checked against, which at least
    says something the category chip does not.
    """
    merged: List[ExtractedMetric] = []
    seen: set = set()

    for candidate in candidates:
        for metric in candidate.patient_summary:
            name = metric.metric_name.strip()
            value = metric.extracted_value.strip()
            if not value:
                continue
            key = (name.lower(), value.lower())
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                ExtractedMetric(
                    category=metric.category,
                    metric_name=name or "Recorded value",
                    extracted_value=value,
                )
            )

    if merged:
        return merged

    for candidate in candidates:
        for node in candidate.compliance_matrix:
            value = node.patient_fact.strip()
            if not value:
                continue
            name = node.trial_rule.strip() or "Recorded value"
            if len(name) > 60:
                name = name[:57].rstrip() + "..."
            key = (name.lower(), value.lower())
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                ExtractedMetric(
                    category=node.category
                    if node.category in _SUMMARY_CATEGORIES
                    else "COMORBIDITIES",
                    metric_name=name,
                    extracted_value=value,
                )
            )

    return merged


async def _score_one_trial(
    study: Dict[str, Any],
    patient_text: str,
    semaphore: asyncio.Semaphore,
    failures: List[str],
    near: str = "",
    deadline: Optional[float] = None,
    record_chars_seen: Optional[List[int]] = None,
    say=None,
) -> Optional[TrialCandidate]:
    """
    Fetch one trial's criteria, run the compliance matrix, and score it.

    Retries once with backoff: free-tier providers rate-limit hard under concurrency,
    and a 429 was silently dropping trials that scored fine in isolation. Genuine
    failures are appended to `failures` so the response can report them rather than
    quietly returning a shorter list; a missing trial the clinician never hears
    about is worse than a visible error.

    `deadline` is a monotonic timestamp past which no new attempt begins. It is
    checked rather than enforced with a cancel so trials already scored survive: the
    caller keeps every result and hears about the rest through `failures`.
    """
    meta = _summarize_study(study, near)
    if not meta["nct_id"]:
        return None

    if record_chars_seen is None:
        record_chars_seen = []

    trial_started = time.monotonic()
    last_error = ""
    # Initialised here, not in the except branch: the deadline check below can
    # `break` before any exception is raised, and the log line after the loop
    # reads this unconditionally.
    safe_error = "deadline"
    for attempt in range(2):
        if deadline is not None and time.monotonic() >= deadline:
            last_error = (
                "skipped: the discovery run passed its "
                f"{DISCOVERY_TOTAL_TIMEOUT_SECONDS}s budget before this trial started"
            )
            break
        async with semaphore:
            try:
                criteria = await asyncio.to_thread(
                    _fetch_ctgov_criteria, meta["nct_id"]
                )
                raw, chars_sent = await asyncio.wait_for(
                    asyncio.to_thread(
                        _generate_with_shrink,
                        patient_text,
                        criteria[:MAX_TRIAL_CHARS],
                        DISCOVERY_MAX_RECORD_CHARS,
                    ),
                    timeout=LLM_TOTAL_TIMEOUT_SECONDS,
                )
                # Each trial is fitted independently, so one that had to shrink
                # must not let the run report the full record as screened.
                record_chars_seen.append(chars_sent)
                payload = ClinixPathPayload.model_validate(_coerce_json(raw))
                # A trial with no rows was not screened, whatever the schema says.
                # Surfacing it as a candidate would put "no criteria returned"
                # behind a verdict chip; reporting it as a failure says what
                # actually happened, and the retry above gets a second chance at it.
                if not payload.compliance_matrix:
                    raise ValueError("the model returned an empty compliance matrix")
                if say:
                    say(
                        "trial",
                        nct_id=meta["nct_id"],
                        title=meta.get("title", ""),
                        status="scored",
                        rows=len(payload.compliance_matrix),
                    )
                log.info(
                    "trial ok  %-14s %6.1fs  attempt %d  %d rows",
                    meta["nct_id"],
                    time.monotonic() - trial_started,
                    attempt + 1,
                    len(payload.compliance_matrix),
                )
                return TrialCandidate(
                    **meta,
                    **_score_matrix(payload.compliance_matrix),
                    compliance_matrix=payload.compliance_matrix,
                    patient_summary=payload.patient_summary,
                    trial_criteria=criteria[:MAX_TRIAL_CHARS],
                )
            except Exception as exc:
                # Full text for the CALLER (it is shown once, never stored);
                # only the safe form is written to the log.
                last_error = f"{type(exc).__name__}: {exc}"
                safe_error = _safe_error(exc)
        if attempt == 0:
            # Outside the semaphore so a sleeping retry does not hold a slot.
            await asyncio.sleep(2.0)

    if say:
        say(
            "trial",
            nct_id=meta["nct_id"],
            title=meta.get("title", ""),
            status="failed",
            reason=safe_error,
        )
    log.info(
        "trial FAIL %-13s %6.1fs  %s",
        meta["nct_id"],
        time.monotonic() - trial_started,
        safe_error,
    )
    failures.append(f"{meta['nct_id']} ({last_error[:120]})")
    return None


async def _run_discovery(
    patient_text: str,
    location: str = "",
    condition: str = "",
    max_trials: int = 0,
    exclude_nct: str = "",
    emit=None,
) -> DiscoveryPayload:
    """
    The discovery pipeline, independent of how its result is delivered.

    Extracted from the route so the same code can serve a plain JSON response and
    a streamed one. Duplicating it for the streaming endpoint would have been the
    obvious shortcut and the wrong one: the two would drift, and the streamed
    version is the one a clinician actually watches.

    `emit` is an optional callback taking (event_name, payload_dict). It is how
    the pipeline reports progress WITHOUT knowing anything about SSE, HTTP or the
    browser. When it is None — the plain endpoint — every call is a no-op and the
    pipeline behaves exactly as before.

    THE PIPELINE. One patient record, every recruiting trial, ranked. This inverts
    the single-trial check: a clinician rarely knows which protocol to test
    against; they have a patient and need to know what is open and reachable.

    Derive the condition from the record -> search RECRUITING studies -> score
    each concurrently -> rank. Same de-identification contract as /api/analyze:
    the record arrives already scrubbed and is purged before returning.
    """
    def _say(event: str, **fields) -> None:
        if emit is not None:
            emit(event, fields)

    record = (patient_text or "").strip()
    if not record:
        raise HTTPException(status_code=400, detail="'patient_text' must not be empty.")

    if leaked := _detect_obvious_identifiers(record):
        raise HTTPException(
            status_code=422,
            detail=(
                "The submitted text still contains direct identifiers "
                f"({', '.join(leaked)}). De-identify before submitting."
            ),
        )

    require_api_key()
    max_trials = max(1, min(int(max_trials or DEFAULT_MAX_TRIALS), 10))

    # Provisional: assumes every trial got the full cap. Trials can now shrink
    # independently when a provider's context turns out smaller, so this is
    # corrected from what was actually sent once the fan-out completes.
    truncation = TruncationNotice(
        record_truncated=len(record) > DISCOVERY_MAX_RECORD_CHARS,
        record_chars_used=min(len(record), DISCOVERY_MAX_RECORD_CHARS),
        record_chars_total=len(record),
    )
    # One entry per scored trial. The notice reports the SMALLEST, because the
    # claim being made is "every verdict here rests on at least this much record".
    record_chars_seen: List[int] = []

    run_started = time.monotonic()
    try:
        search_condition = condition.strip()
        # Defined before the branch, not inside it: a caller-supplied condition
        # skips the derivation entirely, and reading this afterwards would raise
        # NameError on the one path that never touches the model.
        search_keywords: List[str] = []

        if not search_condition:
            # Bounded like every other model call. This one was not, and it is the
            # FIRST thing discovery does, so a stalled provider hung the whole run
            # before a single trial was fetched. `requests`' read timeout does not
            # cover it: that bounds the gap between bytes, not the call.
            try:
                terms = await asyncio.wait_for(
                    asyncio.to_thread(_derive_search_terms, record),
                    timeout=LLM_TOTAL_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError as exc:
                raise HTTPException(
                    status_code=504,
                    detail=(
                        "The model did not return a search condition within "
                        f"{LLM_TOTAL_TIMEOUT_SECONDS}s. Retry, or name the condition "
                        "explicitly in the search field to skip this step."
                    ),
                ) from exc
            except RuntimeError as exc:
                # Every provider failing here used to escape as a bare 500, so the
                # UI said "unexpected RuntimeError" for the most ordinary failure
                # there is — a free tier out of quota. The chain's own message
                # already names the provider, the status and the reset window; it
                # just never got out of this block. The SCORING phase has always
                # reported these properly, which is why this only showed up on the
                # very first model call of a run.
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Could not derive a search condition: {exc} "
                        "You can also type the condition into the search field to "
                        "skip this step entirely."
                    ),
                ) from exc
            search_condition = terms.condition.strip()
            # Biomarkers, mutations and stage. Derived on every run since this
            # endpoint was written and never once used — see the note in
            # _search_recruiting_trials for what that cost.
            search_keywords = [k.strip() for k in terms.keywords if k and k.strip()]
        if not search_condition:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Could not determine a condition from the record. Provide one "
                    "explicitly via the 'condition' field."
                ),
            )

        # Parsed before the search, because the page size depends on how many
        # studies will be thrown away.
        already = {
            part.strip().upper()
            for part in (exclude_nct or "").split(",")
            if part.strip()
        }

        try:
            studies, location_relaxed = await asyncio.to_thread(
                _search_recruiting_trials,
                search_condition,
                location,
                # Room for the shortlist AND everything already screened. On a
                # continuation the exclusions are subtracted from THIS page, so a
                # page sized only for the shortlist comes back entirely excluded:
                # a "screen more" that had already screened four asked for four
                # studies, removed all four, and reported nothing left to look at.
                (max_trials + len(already)) * 2,
                search_keywords,
            )
        except Exception as exc:
            # `_safe_error`, not the raw exception. `requests` puts the FULL
            # request URL in its message, and that URL carries query.term — the
            # biomarkers and stage derived from the patient's chart. An error
            # panel was rendering "PD-L1 65% stage IV KRAS G12C" as a 500 message.
            # It is the user's own data on the user's own screen, but a clinical
            # summary has no business being the text of a network error.
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The trial registry did not respond ({_safe_error(exc)}). "
                    "This is usually momentary; the search was retried three "
                    "times. Try again in a minute."
                ),
            ) from exc

        if not studies:
            return DiscoveryPayload(
                search_condition=search_condition,
                location_relaxed=location_relaxed,
                trials_screened=0,
                candidates=[],
                truncation=truncation,
            )

        _say("searched", condition=search_condition, found=len(studies))
        log.info(
            "phase     search+derive done %6.1fs  condition=<%d chars>  %d studies found",
            time.monotonic() - run_started,
            len(search_condition),
            len(studies),
        )

        # Drop anything the caller has already screened, THEN take the cap, so a
        # continuation request screens genuinely new studies rather than paying
        # for the same four again.
        if already:
            studies = [
                s
                for s in studies
                if (
                    s.get("protocolSection", {})
                    .get("identificationModule", {})
                    .get("nctId", "")
                    .upper()
                )
                not in already
            ]
            log.info(
                "phase     continuation: %d already screened, %d remain",
                len(already),
                len(studies),
            )

        shortlist = studies[:max_trials]
        # Bounded concurrency: free-tier providers rate-limit aggressively, and a
        # burst of parallel calls is the fastest way to get throttled mid-demo.
        _say("screening", total=len(shortlist))
        failures: List[str] = []
        semaphore = asyncio.Semaphore(DISCOVERY_CONCURRENCY)
        deadline = time.monotonic() + DISCOVERY_TOTAL_TIMEOUT_SECONDS
        scored = await asyncio.gather(
            *(
                _score_one_trial(
                    s, record, semaphore, failures, location, deadline,
                    record_chars_seen, _say,
                )
                for s in shortlist
            )
        )
        candidates = [c for c in scored if c is not None]
        candidates.sort(key=lambda c: (-c.score, c.conflict_count, -c.match_count))

        # Correct the provisional notice to what the model was really shown. If any
        # trial had to shrink, the weakest evidence is what the run stands on.
        if record_chars_seen:
            actually_used = min(record_chars_seen)
            truncation = TruncationNotice(
                record_truncated=actually_used < len(record),
                record_chars_used=actually_used,
                record_chars_total=len(record),
            )

        log.info(
            "RUN DONE  %6.1fs total  %d/%d trials scored  concurrency=%d  model=%s",
            time.monotonic() - run_started,
            len(candidates),
            len(shortlist),
            DISCOVERY_CONCURRENCY,
            _active_provider()["model"],
        )

        # The snapshot is the union of what every scored trial reported, not one
        # trial's view of the patient.
        #
        # Each scoring call already returns a patient_summary next to its matrix, so
        # this costs no extra model call. Taking only the richest single matrix, as
        # this did before, threw away every fact the other trials surfaced and left
        # the checklist showing one or two rows for a record full of them. Trials ask
        # about different things by design; the patient is the union, not the
        # intersection.
        #
        # Deduped on metric name plus value so the same fact reported by four trials
        # appears once, while two genuinely different values under one name (a lab
        # drawn twice) both survive to be seen.
        summary = _merge_patient_summaries(candidates)

        return DiscoveryPayload(
            # Was 10, which was generous for one trial's facts and tight for six
            # trials' worth. The rail scrolls with the page, so a longer list costs
            # nothing; silently dropping half the record cost the panel its point.
            patient_summary=summary[:24],
            search_condition=search_condition,
            location_relaxed=location_relaxed,
            trials_screened=len(shortlist),
            candidates=candidates,
            failed=failures,
            truncation=truncation,
        )
    finally:
        # RAM purge, same contract as /api/analyze.
        record = ""
        del record




@app.post("/api/discover", response_model=DiscoveryPayload)
async def discover(
    patient_text: str = Form(..., description="De-identified patient record text."),
    location: str = Form("", description="Optional 'City, State' to search near."),
    condition: str = Form("", description="Optional override for the search condition."),
    max_trials: int = Form(0, description="How many trials to score (1-10). 0 uses the server default."),
    exclude_nct: str = Form(
        "",
        description="Comma-separated NCT ids already screened; they are skipped.",
    ),
    session_id: str = Form("demo-user", description="Hardcoded demo session id."),
) -> DiscoveryPayload:
    """
    Discovery flow: one patient record, every recruiting trial, ranked.

    Delivers the finished payload in one response. `/api/discover/stream` runs the
    identical pipeline and reports each stage as it happens; see _run_discovery.
    """
    return await _run_discovery(
        patient_text=patient_text,
        location=location,
        condition=condition,
        max_trials=max_trials,
        exclude_nct=exclude_nct,
    )



@app.post("/api/discover/stream")
async def discover_stream(
    patient_text: str = Form(...),
    location: str = Form(""),
    condition: str = Form(""),
    max_trials: int = Form(0),
    exclude_nct: str = Form(""),
    session_id: str = Form("demo-user"),
):
    """
    The same pipeline, reported as it happens.

    WHY THIS EXISTS. A discovery run takes one to three minutes and the browser
    learned nothing until it finished, so the wait screen could only show a
    plausible SEQUENCE of stages on a timer and had to admit as much in the copy.
    Meanwhile the server knew exactly what it was doing and was writing it to a
    log nobody watching the page could see.

    WIRE FORMAT. Server-sent events, one JSON object per `data:` line:
        searched   {condition, found}      the registry answered
        screening  {total}                 how many trials will be scored
        trial      {nct_id, title, status} each one, as it lands or fails
        done       {payload}               the complete DiscoveryPayload
        error      {detail}                the run failed; nothing follows

    Events go through a queue rather than being yielded directly because the
    pipeline is a fan-out of concurrent tasks — several trials finish at once,
    and a queue is what lets them report without waiting for each other.

    A POST rather than GET, so EventSource cannot be used: the record is form
    data and must not sit in a URL. The client reads the body stream instead.
    """
    events: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(event: str, fields: Dict[str, Any]) -> None:
        # Called from the pipeline, which may be on a worker thread. Hop back to
        # the loop rather than touching the queue directly.
        loop.call_soon_threadsafe(
            events.put_nowait, json.dumps({"event": event, **fields})
        )

    async def run() -> None:
        try:
            payload = await _run_discovery(
                patient_text=patient_text,
                location=location,
                condition=condition,
                max_trials=max_trials,
                exclude_nct=exclude_nct,
                emit=emit,
            )
            await events.put(
                json.dumps({"event": "done", "payload": payload.model_dump()})
            )
        except HTTPException as exc:
            await events.put(
                json.dumps({"event": "error", "detail": str(exc.detail)})
            )
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            # Same contract as the global handler: the type, never the message,
            # because an unanticipated exception can quote the record it choked on.
            await events.put(
                json.dumps(
                    {
                        "event": "error",
                        "detail": (
                            f"The service hit an unexpected {type(exc).__name__} "
                            "and stopped this run. Nothing was retained."
                        ),
                    }
                )
            )
            log.info("stream    run failed  %s", _safe_error(exc))
        finally:
            # The sentinel is what ends the response; without it the client waits
            # on a socket that will never speak again.
            await events.put(None)

    async def body():
        task = asyncio.create_task(run())
        try:
            while True:
                chunk = await events.get()
                if chunk is None:
                    break
                yield f"data: {chunk}\n\n"
        finally:
            # A client that closes the tab mid-run must not leave the fan-out
            # running against a metered provider for another two minutes.
            if not task.done():
                task.cancel()

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Proxies that buffer would defeat the entire point of streaming.
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/analyze", response_model=ClinixPathPayload)
async def analyze(
    trial_url: str = Form(..., description="Public URL of the clinical trial page."),
    # The PDF is parsed and de-identified in the browser (see frontend/src/lib/).
    # This service never receives the file: only clinician-approved, de-identified text.
    patient_text: str = Form(..., description="De-identified patient record text."),
    # PRD section 1: no auth. The frontend posts a hardcoded 'demo-user' session.
    # Accepted and echoed in logs only: nothing is persisted (no database).
    session_id: str = Form("demo-user", description="Hardcoded demo session id."),
) -> ClinixPathPayload:
    """
    Cross-reference de-identified patient text against a trial's eligibility criteria.

    Pipeline: de-identified text (from the browser) | trial URL -> criteria text |
    both -> LLM -> schema-validated ClinixPathPayload. All buffers are purged
    before returning.
    """
    # --- input sanity checks --------------------------------------------------
    if not trial_url or not trial_url.strip():
        raise HTTPException(status_code=400, detail="'trial_url' must not be empty.")

    patient_record_text = (patient_text or "").strip()
    if not patient_record_text:
        raise HTTPException(
            status_code=400, detail="'patient_text' must not be empty."
        )

    # Defence in depth. De-identification is the browser's job, but a direct API
    # caller could bypass it entirely, so obvious direct identifiers are rejected
    # here rather than forwarded to a third-party model.
    if leaked := _detect_obvious_identifiers(patient_record_text):
        raise HTTPException(
            status_code=422,
            detail=(
                "The submitted text still contains direct identifiers "
                f"({', '.join(leaked)}). De-identify before submitting; this "
                "service will not forward PHI to the model."
            ),
        )

    trial_criteria_text: Optional[str] = None
    prompt: Optional[str] = None
    raw_model_json: Optional[str] = None

    try:
        # --- STEP B: resolve the trial URL to criteria text --------------------
        # PRD section 5: an empty/failed scrape is a hard 400, not a degraded run.
        # Without trial criteria there is nothing to cross-reference against, so a
        # partial matrix would be misleading rather than merely incomplete.
        fetch_error: Optional[str] = None
        try:
            trial_criteria_text = await asyncio.to_thread(_fetch_trial_text, trial_url)
        except Exception as exc:
            trial_criteria_text = ""
            fetch_error = f"{type(exc).__name__}: {exc}"

        if not trial_criteria_text or not trial_criteria_text.strip():
            raise HTTPException(
                status_code=400,
                detail=(
                    "Failed to safely scrape structured text formatting from the "
                    "provided trial URL. Confirm the URL is reachable and public. "
                    "ClinicalTrials.gov links (any URL containing an NCT id) use the "
                    "official registry API and need no configuration."
                    + (f" Underlying error, {fetch_error}" if fetch_error else "")
                ),
            )

        # --- context-window guards --------------------------------------------
        truncated_trial_text = trial_criteria_text[:MAX_TRIAL_CHARS]

        # --- STEP C: AI processing --------------------------------------------
        # Key check happens here so the pipeline order holds: input and trial-fetch
        # failures surface as 4xx before any AI configuration is attempted.
        require_api_key()

        try:
            # Fitting happens inside, so the notice below can report the size that
            # actually reached the model rather than the size we intended.
            raw_model_json, record_chars_sent = await asyncio.wait_for(
                asyncio.to_thread(
                    _generate_with_shrink, patient_record_text, truncated_trial_text
                ),
                timeout=LLM_TOTAL_TIMEOUT_SECONDS,
            )
        except HTTPException:
            raise
        except asyncio.TimeoutError as exc:
            # 504, not 502: the upstream did not misbehave, it simply did not
            # answer in time. The message names the real cause, because "analysis
            # failed" sends people looking for a bug that is not there.
            raise HTTPException(
                status_code=504,
                detail=(
                    f"The model did not respond within {LLM_TOTAL_TIMEOUT_SECONDS}s. "
                    "Free-tier providers queue behind paid traffic; retry, or switch "
                    "LLM_MODEL in backend/.env to a faster model."
                ),
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"The LLM analysis call failed: {exc}",
            ) from exc

        # Built AFTER the call, from the size the model was really given: a retry
        # at a smaller size must not be reported as a full-record reading.
        truncation = TruncationNotice(
            record_truncated=record_chars_sent < len(patient_record_text),
            record_chars_used=record_chars_sent,
            record_chars_total=len(patient_record_text),
            criteria_truncated=len(trial_criteria_text) > MAX_TRIAL_CHARS,
        )

        # --- structured-output verification ------------------------------------
        try:
            parsed = _coerce_json(raw_model_json)
            payload = ClinixPathPayload.model_validate(parsed)
            # Attach the criteria the verdicts were drawn from, so the UI can
            # highlight each criterion_quote inside its real context.
            payload.trial_criteria = truncated_trial_text
            # And say plainly how much of the record those verdicts actually saw.
            payload.truncation = truncation
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            raise HTTPException(
                status_code=502,
                detail=(
                    "The AI response did not match the required ClinixPath schema: "
                    f"{exc}"
                ),
            ) from exc

        return payload

    finally:
        # STATELESS GUARANTEE: RAM PURGE.
        # Every buffer holding medical content is dropped here so the process keeps
        # no patient data after the response is serialized. Nothing is written to
        # disk and nothing is retained in memory beyond this request. Note the file
        # itself never reaches this service; the browser parses and de-identifies it.
        patient_record_text = ""
        trial_criteria_text = None
        prompt = None
        raw_model_json = None
        del patient_record_text, trial_criteria_text, prompt, raw_model_json


if __name__ == "__main__":  # pragma: no cover - convenience launcher
    import uvicorn

    # LOOPBACK, NOT 0.0.0.0.
    #
    # This service has no authentication by design, accepts clinical text, and
    # spends a metered API budget on every request. Binding every interface put
    # all three on the local network: anyone on the same cafe or campus wifi
    # could POST to /api/analyze.
    #
    # CORS does not help — it constrains browsers, and the exposure here is a
    # plain HTTP client. Override with HOST=0.0.0.0 only behind something that
    # actually authenticates.
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        reload=True,
    )
