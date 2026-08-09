#!/usr/bin/env python3
"""
Reasoning eval for ClinixPath.

    cd backend && ./.venv/bin/python eval/run.py            # cached where possible
    cd backend && ./.venv/bin/python eval/run.py --refresh  # force fresh model calls
    cd backend && ./.venv/bin/python eval/run.py --model X  # try a model without editing .env

Mirrors frontend/src/lib/deidentify.test.mjs: no framework, runs from the command
line, exits non-zero on failure so it can gate a change.

WHY THIS EXISTS
The scrubber has 34 tests because three leaks shipped that careful reading did not
catch. The reasoning layer had none, so every model swap and prompt edit was judged
by eyeballing one run — which produced a confident, wrong claim about output quality
inside an hour. This turns "does that look better?" into a number.

RESPONSES ARE CACHED ON DISK. A free-tier key is metered in requests per day, and an
eval you cannot afford to run is an eval nobody runs. Only cache misses cost quota,
so iterating on scoring logic is free; --refresh forces real calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
from cases import CASES, _plumbing_checks  # noqa: E402  (same directory)

CACHE_DIR = Path(__file__).resolve().parent / ".cache"


def _cache_key(model: str, prompt: str) -> Path:
    digest = hashlib.sha256(f"{model}\x00{prompt}".encode()).hexdigest()[:32]
    return CACHE_DIR / f"{digest}.json"


def _run_case(case: Dict[str, Any], model: str, refresh: bool) -> Dict[str, Any]:
    criteria = main._fetch_ctgov_criteria(case["nct_id"])
    prompt = main.build_prompt(
        case["patient"][: main.MAX_PDF_CHARS], criteria[: main.MAX_TRIAL_CHARS]
    )

    cache_path = _cache_key(model, prompt)
    if not refresh and cache_path.exists():
        cached = json.loads(cache_path.read_text())
        return {
            "matrix": cached["compliance_matrix"],
            # `.get` because entries cached before the summary floor existed are
            # still valid matrices; they just cannot answer the fact assertion.
            "summary": cached.get("patient_summary", []),
            "cached": True,
            "secs": 0.0,
        }

    started = time.time()
    raw = main._generate_structured_payload(prompt)
    elapsed = time.time() - started

    payload = main.ClinixPathPayload.model_validate(main._coerce_json(raw))
    serialised = payload.model_dump()

    CACHE_DIR.mkdir(exist_ok=True)
    cache_path.write_text(json.dumps(serialised, indent=2))
    return {
        "matrix": serialised["compliance_matrix"],
        "summary": serialised["patient_summary"],
        "cached": False,
        "secs": elapsed,
    }


def _find_row(matrix: List[Dict[str, Any]], keywords: List[str]) -> Dict[str, Any] | None:
    """Locate the row whose trial_rule contains every keyword (case-insensitive)."""
    for row in matrix:
        haystack = f"{row.get('trial_rule', '')}".lower()
        if all(k.lower() in haystack for k in keywords):
            return row
    return None


def _run_plumbing() -> int:
    """Deterministic checks on the code around the model. No quota, no network."""
    print("PLUMBING (no model calls)")
    failed = 0
    for name, check in _plumbing_checks(main):
        try:
            check()
            print(f"  ok       {name}")
        except AssertionError as exc:
            print(f"  FAIL     {name}: {exc}")
            failed += 1
        except Exception as exc:  # a check that cannot even run is a failure
            print(f"  ERROR    {name}: {type(exc).__name__}: {exc}")
            failed += 1
    print()
    return failed


def main_eval() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="ignore cached responses")
    parser.add_argument("--model", help="override LLM_MODEL for this run only")
    parser.add_argument(
        "--plumbing-only",
        action="store_true",
        help="skip the model cases; run only the free deterministic checks",
    )
    # A free tier meters tokens per MINUTE, so a suite that fires every case back
    # to back fails on quota rather than on quality — three cases errored out the
    # first time this file grew past five. The pause is only paid on a cache MISS,
    # so a settled suite still runs at full speed.
    parser.add_argument(
        "--pace",
        type=float,
        default=35.0,
        help="seconds to wait after each fresh model call (0 to disable)",
    )
    args = parser.parse_args()

    plumbing_failures = _run_plumbing()
    if args.plumbing_only:
        print("=" * 62)
        if plumbing_failures:
            print(f"{plumbing_failures} plumbing check(s) failed")
        else:
            print("all plumbing checks passed")
        return 1 if plumbing_failures else 0

    if args.model:
        os.environ["LLM_MODEL"] = args.model
    model = main._active_provider()["model"]

    print(f"model:    {model}")
    print(f"provider: {main._active_provider()['name']}")
    print(f"cases:    {len(CASES)}\n")

    passed = failed = missing = 0
    errors: List[str] = []

    for index, case in enumerate(CASES):
        try:
            result = _run_case(case, model, args.refresh)
        except Exception as exc:
            print(f"  {case['name']}: ERROR {type(exc).__name__}: {str(exc)[:90]}")
            errors.append(case["name"])
            failed += len(case["assertions"])
            # A rate limit does not clear on its own during a tight loop; without
            # this every remaining case inherits the same failure and the run
            # reports a suite-wide collapse that is really one exhausted bucket.
            if args.pace and index < len(CASES) - 1:
                time.sleep(args.pace)
            continue

        # Only a fresh call spends quota, so only a fresh call pays the pause.
        if not result["cached"] and args.pace and index < len(CASES) - 1:
            time.sleep(args.pace)

        tag = "cached" if result["cached"] else f"{result['secs']:.0f}s"
        rows = len(result["matrix"])
        facts = len(result["summary"])
        print(f"  {case['name']}  ({tag}, {rows} rows, {facts} facts)")

        # A collapsed matrix passes every keyword assertion below, because they only
        # inspect rows that exist. The floor is what notices the collapse.
        floor = case.get("min_rows", 0)
        if rows < floor:
            print(f"      FAIL     only {rows} rows, expected at least {floor}")
            failed += 1
        elif floor:
            print(f"      ok       {rows} rows (floor {floor})")
            passed += 1

        # The matrix and the summary fail independently: the matrix answers the
        # trial's questions, the summary describes the patient. A run once returned
        # ten correct rows next to a two-fact summary, and every assertion passed.
        fact_floor = case.get("min_facts", 0)
        if facts < fact_floor:
            print(f"      FAIL     only {facts} facts, expected at least {fact_floor}")
            failed += 1
        elif fact_floor:
            print(f"      ok       {facts} facts (floor {fact_floor})")
            passed += 1

        # A count alone is satisfiable with filler. These name the facts whose
        # absence would misrepresent the patient — the diagnosis above all.
        haystack = " ".join(
            f"{m.get('metric_name', '')} {m.get('extracted_value', '')}"
            for m in result["summary"]
        ).lower()
        for keyword in case.get("summary_mentions", []):
            if keyword.lower() in haystack:
                print(f"      ok       summary mentions {keyword!r}")
                passed += 1
            else:
                print(f"      FAIL     summary never mentions {keyword!r}")
                failed += 1

        # The inverse. A summary can hit its count and still be junk: on a serial
        # chart the model once returned 22 of 24 entries as "Prior Therapy Visit N",
        # which passed every floor above while saying almost nothing about the
        # patient. Naming what must NOT appear is the only check that sees it.
        for keyword in case.get("summary_forbids", []):
            if keyword.lower() in haystack:
                print(f"      FAIL     summary repeats per-visit entry {keyword!r}")
                failed += 1
            else:
                print(f"      ok       summary avoids {keyword!r}")
                passed += 1

        for assertion in case["assertions"]:
            row = _find_row(result["matrix"], assertion["match"])
            label = " + ".join(assertion["match"])
            if row is None:
                # The model never produced a row for this criterion. That is a real
                # failure (a missed criterion), not a reason to skip the check.
                print(f"      MISSING  {label!r} — no row covers this criterion")
                missing += 1
                failed += 1
                continue
            actual = row.get("status")
            if actual == assertion["expect"]:
                print(f"      ok       {label!r} -> {actual}")
                passed += 1
            else:
                print(
                    f"      FAIL     {label!r} -> got {actual}, "
                    f"expected {assertion['expect']}"
                )
                print(f"               reason: {str(row.get('explanation'))[:88]}")
                failed += 1
        print()

    total = passed + failed
    pct = (100.0 * passed / total) if total else 0.0
    print("=" * 62)
    print(f"{passed}/{total} assertions passed ({pct:.0f}%)")
    if missing:
        print(f"{missing} criteria had no row at all")
    if errors:
        print(f"{len(errors)} case(s) errored: {', '.join(errors)}")
    if plumbing_failures:
        print(f"{plumbing_failures} plumbing check(s) failed")
    return 0 if failed == 0 and plumbing_failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main_eval())
