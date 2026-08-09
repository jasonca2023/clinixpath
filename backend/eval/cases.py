"""
Labeled cases for the reasoning eval.

Each case pairs a synthetic (never real) patient record with a REAL trial pulled
live from ClinicalTrials.gov, plus assertions about individual criteria.

Assertions match a criterion by keyword rather than by index, because the model
does not guarantee row order and registries edit criteria text over time. A
keyword that stops matching is reported as MISSING, not as a pass — silently
skipping an assertion is how an eval suite rots into decoration.

Only unambiguous expectations belong here. If a reasonable clinician could argue
either way, the case teaches the suite nothing and will flap between runs. Every
assertion below is defensible from the record text alone:

  - arithmetic on a stated age
  - a treatment history the record states explicitly
  - data that is genuinely absent from any medical record (consent, scheduling)
"""

# A blood-draw biomarker study whose defining requirement is that the primary
# malignancy be UNTREATED. That makes it unusually good for evaluation: the same
# trial yields MATCH or CONFLICT depending only on treatment history, so a model
# that pattern-matches on cancer type alone fails visibly.
UNTREATED_SOLID_TUMOR = "NCT03662204"

# A KRAS-targeted platform study. Chosen for three reasons: its criteria are short
# (~1,300 characters, so a case costs little quota), they are unusually crisp, and
# they discriminate on axes the first trial does not — a named mutation, a bounded
# performance status, and an exclusion that a record can satisfy by DENYING it.
#
# It also covers "solid tumor malignancy" as well as NSCLC, so the same trial can
# test a lung case and a colorectal one without a second fetch.
RAS_PLATFORM = "NCT06162221"

CASES = [
    {
        "name": "treated-patient-vs-untreated-only-trial",
        "nct_id": UNTREATED_SOLID_TUMOR,
        "patient": (
            "62-year-old with stage IV non-small cell lung carcinoma, adenocarcinoma "
            "histology. ECOG performance status 1. EGFR exon 19 deletion positive. "
            "Prior therapy: carboplatin/pemetrexed x4 cycles completed, with "
            "documented radiographic progression. No brain metastases on MRI three "
            "weeks ago. Creatinine 0.9 mg/dL, ANC 3200 cells/uL, platelets 210 K/uL."
        ),
        # A model that answers three criteria out of thirty is not "mostly right",
        # it has silently dropped the rest of the protocol — and every assertion
        # below would still pass, because they only check the rows that exist.
        # Row count dropped 10 -> 6 on a prompt edit once and nothing noticed.
        "min_rows": 5,
        # Nine distinct facts are stated outright: age, diagnosis, ECOG, EGFR,
        # prior therapy, brain-met status, creatinine, ANC, platelets.
        "min_facts": 7,
        "summary_mentions": ["carcinoma", "EGFR", "ECOG"],
        "assertions": [
            # 62 > 18. Pure arithmetic on a stated value.
            {"match": ["18 years of age"], "expect": "MATCH"},
            # The record states completed chemotherapy; the trial requires the
            # malignancy be untreated. This is the case's whole point.
            {"match": ["untreated primary malignancy"], "expect": "CONFLICT"},
            # Nothing in any medical record establishes that a subject understands
            # study procedures. UNKNOWN is the correct answer, not a failure.
            {"match": ["understands the study procedures"], "expect": "UNKNOWN"},
        ],
    },
    {
        "name": "untreated-patient-same-trial",
        "nct_id": UNTREATED_SOLID_TUMOR,
        "patient": (
            "58-year-old with a newly identified breast mass, biopsy-confirmed "
            "invasive ductal carcinoma. No prior chemotherapy, no prior radiation, "
            "no prior surgery for this or any malignancy. Treatment-naive at "
            "presentation. ECOG performance status 0. Hemoglobin 12.8 g/dL."
        ),
        "min_rows": 5,
        # Age, diagnosis, treatment-naive status, ECOG, haemoglobin.
        "min_facts": 4,
        "summary_mentions": ["carcinoma", "12.8"],
        "assertions": [
            {"match": ["18 years of age"], "expect": "MATCH"},
            # Same criterion as the case above, opposite verdict. A model that
            # answers both identically has learned nothing from the record.
            {"match": ["untreated primary malignancy"], "expect": "MATCH"},
        ],
    },
    {
        "name": "underage-patient",
        "nct_id": UNTREATED_SOLID_TUMOR,
        "patient": (
            "16-year-old with newly diagnosed osteosarcoma of the distal femur. "
            "No prior systemic therapy. ECOG performance status 1. "
            "Referred from pediatric oncology."
        ),
        "min_rows": 5,
        # The shortest record in the suite, and the one that exposed the defect:
        # the model returned two facts and dropped the osteosarcoma, describing a
        # patient with an age and a negative and no disease. Four facts are stated.
        "min_facts": 4,
        "summary_mentions": ["osteosarcoma", "ECOG"],
        "assertions": [
            # 16 < 18, and the trial states a minimum age of 18. A model that
            # returns MATCH here is not reading the number.
            {"match": ["18 years of age"], "expect": "CONFLICT"},
        ],
    },
    # ------------------------------------------------------------------
    # KRAS platform study. Same trial, four patients, four different reasons
    # to be eligible or not — so a model that keys off "lung cancer" fails.
    # ------------------------------------------------------------------
    {
        "name": "kras-g12c-positive-nsclc",
        "nct_id": RAS_PLATFORM,
        "patient": (
            "64-year-old with metastatic non-small cell lung carcinoma. Next-generation "
            "sequencing: KRAS G12C mutation detected at 28% variant allele frequency. "
            "ECOG performance status 1. Completed first-line carboplatin/pemetrexed with "
            "subsequent progression. No history of interstitial lung disease or "
            "pneumonitis. No central nervous system primary tumor."
        ),
        "min_rows": 5,
        "min_facts": 5,
        "summary_mentions": ["KRAS", "ECOG"],
        "assertions": [
            {"match": ["18 years of age"], "expect": "MATCH"},
            # The mutation the trial is built around, stated outright.
            {"match": ["KRAS G12C"], "expect": "MATCH"},
            # ECOG 1 sits inside "0 to 1". Arithmetic on a stated value again.
            {"match": ["ECOG"], "expect": "MATCH"},
            # An explicit denial SETTLES an exclusion. Answering UNKNOWN here means
            # the model is looking for the fact restated in the trial's words
            # instead of reading what the record says.
            {"match": ["interstitial lung disease"], "expect": "MATCH"},
        ],
    },
    {
        "name": "kras-wild-type-same-trial",
        "nct_id": RAS_PLATFORM,
        "patient": (
            "59-year-old with metastatic lung adenocarcinoma. Next-generation sequencing: "
            "KRAS wild-type, no G12C substitution detected. EGFR exon 19 deletion present. "
            "ECOG performance status 0. Received prior standard platinum doublet therapy."
        ),
        "min_rows": 5,
        "min_facts": 4,
        "summary_mentions": ["EGFR"],
        "assertions": [
            # Same criterion as the case above, opposite verdict, same cancer type.
            # This is the pair that catches pattern-matching on "lung cancer".
            {"match": ["KRAS G12C"], "expect": "CONFLICT"},
            {"match": ["ECOG"], "expect": "MATCH"},
        ],
    },
    {
        "name": "excluded-by-interstitial-lung-disease",
        "nct_id": RAS_PLATFORM,
        "patient": (
            "67-year-old with metastatic KRAS G12C-mutated non-small cell lung carcinoma. "
            "ECOG performance status 1. Prior carboplatin and pemetrexed. Documented "
            "history of interstitial lung disease requiring a prolonged prednisone course "
            "two years ago. No CNS primary tumor."
        ),
        "min_rows": 5,
        "min_facts": 4,
        "summary_mentions": ["interstitial"],
        "assertions": [
            # Eligible on the mutation, excluded on the lung toxicity. A model that
            # scores the headline biomarker and stops will get this wrong.
            {"match": ["KRAS G12C"], "expect": "MATCH"},
            {"match": ["interstitial lung disease"], "expect": "CONFLICT"},
        ],
    },
    {
        # Not lung. The trial's Subprotocol A covers any KRAS G12C solid tumour, so
        # this checks the model reads the subprotocol rather than assuming NSCLC
        # because every other case in this file is a lung case.
        "name": "kras-g12c-colorectal-not-lung",
        "nct_id": RAS_PLATFORM,
        "patient": (
            "55-year-old with metastatic colorectal adenocarcinoma, liver-dominant "
            "disease. KRAS G12C mutation detected on tissue NGS. ECOG performance "
            "status 1. Prior FOLFOX and FOLFIRI, both with documented progression. "
            "No interstitial lung disease. No primary CNS tumor."
        ),
        "min_rows": 5,
        "min_facts": 4,
        "summary_mentions": ["colorectal", "KRAS"],
        "assertions": [
            {"match": ["KRAS G12C"], "expect": "MATCH"},
            {"match": ["18 years of age"], "expect": "MATCH"},
        ],
    },
    # ------------------------------------------------------------------
    # Deliberately hard: the record's SHAPE is the difficulty, not its content.
    # ------------------------------------------------------------------
    {
        # A serial chart that states the same class of fact at every visit, with a
        # performance status that IMPROVES over time. Two failure modes at once:
        #
        #   1. Emitting one summary entry per visit. Measured: on a chart like this
        #      the model returned 22 of 24 facts as "Prior Therapy Visit N",
        #      crowding out the molecular profile and every lab. `summary_forbids`
        #      is what notices that, since the count alone looked healthy.
        #   2. Reading a superseded value. ECOG was 3 early and is 1 now; only the
        #      current status decides eligibility.
        "name": "repetitive-chart-with-superseded-values",
        "nct_id": RAS_PLATFORM,
        "patient": (
            "SYNTHETIC TEST RECORD. 61-year-old with metastatic KRAS G12C-mutated "
            "non-small cell lung carcinoma.\n"
            "--- Visit 01, 01/2025 --- ECOG performance status 3. ANC 2.1 K/uL. "
            "Hemoglobin 9.9 g/dL. Plan: continue carboplatin plus pemetrexed.\n"
            "--- Visit 02, 03/2025 --- ECOG performance status 3. ANC 2.4 K/uL. "
            "Hemoglobin 10.4 g/dL. Plan: continue carboplatin plus pemetrexed.\n"
            "--- Visit 03, 05/2025 --- ECOG performance status 2. ANC 2.9 K/uL. "
            "Hemoglobin 11.1 g/dL. Plan: continue carboplatin plus pemetrexed.\n"
            "--- Visit 04, 07/2025 --- ECOG performance status 2. ANC 3.1 K/uL. "
            "Hemoglobin 11.6 g/dL. Plan: switch to docetaxel.\n"
            "--- Visit 05, 09/2025 --- ECOG performance status 1. ANC 3.4 K/uL. "
            "Hemoglobin 12.2 g/dL. Plan: continue docetaxel.\n"
            "--- MOST RECENT, 11/2025 --- ECOG performance status 1. ANC 3.6 K/uL. "
            "Hemoglobin 12.5 g/dL. No interstitial lung disease. No CNS primary tumor. "
            "Prior standard therapy completed with progression."
        ),
        "min_rows": 5,
        "min_facts": 4,
        "summary_mentions": ["KRAS"],
        # One entry per visit is the regression this case exists to catch.
        "summary_forbids": ["Visit 01", "Visit 02", "Visit 03"],
        "assertions": [
            # ECOG is 1 as of the most recent note, which is what "ECOG PS is 0 to 1"
            # is asking about. Answering CONFLICT means reading a value the chart
            # has already superseded.
            {"match": ["ECOG"], "expect": "MATCH"},
            {"match": ["KRAS G12C"], "expect": "MATCH"},
        ],
    },
]


# ---------------------------------------------------------------------------
# PLUMBING CHECKS
# ---------------------------------------------------------------------------
#
# Everything above tests the MODEL, costs quota, and takes minutes. Everything
# below tests the code around it, costs nothing, and runs in milliseconds.
#
# The split exists because the model cases caught none of the defects found in the
# last review — an empty matrix scoring as a perfect match, a prose preamble killing
# the parse, a caller-supplied URL reaching localhost. Those are not reasoning
# failures, so no amount of reasoning cases would have found them. Each entry below
# is a bug that actually shipped.

def _plumbing_checks(main):
    """Return (name, callable) pairs. A check raises AssertionError to fail."""

    def empty_matrix_is_not_a_pass():
        got = main._score_matrix([])
        assert got["verdict"] != "LIKELY_ELIGIBLE", got
        assert got["score"] == 0.0, got
        assert "All criteria met" not in got["distance_label"], got

    def json_survives_a_preamble():
        for raw in (
            '{"a": 1}',
            '```json\n{"a": 1}\n```',
            'Here is the JSON you asked for:\n```json\n{"a": 1}\n```',
            'Okay, the user wants an analysis.\n{"a": 1}\nHope that helps.',
        ):
            assert main._coerce_json(raw) == {"a": 1}, raw

    def malformed_json_still_fails():
        try:
            main._coerce_json("not json at all")
        except Exception:
            return
        raise AssertionError("garbage input parsed as JSON")

    def internal_hosts_are_unreachable():
        for url in (
            "http://127.0.0.1:8000/health",
            "https://localhost/x",
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://[::1]/x",
            "http://10.0.0.5/x",
            "file:///etc/passwd",
        ):
            try:
                main._assert_fetchable_url(url)
            except ValueError:
                continue
            raise AssertionError(f"{url} was allowed")
        # ...and the registry itself still is reachable.
        main._assert_fetchable_url("https://clinicaltrials.gov/study/NCT03662204")

    def every_model_call_is_time_bounded():
        import ast
        from pathlib import Path

        source = Path(main.__file__).read_text()
        tree = ast.parse(source)
        waits = {
            n.lineno
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and "wait_for" in ast.unparse(n.func)
        }
        # The three functions that reach a model. Registry HTTP is excluded: it is
        # bounded by FETCH_TIMEOUT_SECONDS and is not a streaming response.
        model_fns = ("_generate_structured_payload", "_derive_search_terms")
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and "to_thread" in ast.unparse(node.func)):
                continue
            called = ast.unparse(node.args[0]) if node.args else ""
            if called not in model_fns:
                continue
            assert any(abs(node.lineno - w) <= 2 for w in waits), (
                f"{called} at line {node.lineno} has no asyncio.wait_for around it"
            )

    def shrinking_stops_when_it_changes_nothing():
        """
        The context-overflow retry must not re-send an identical prompt.

        `_fit_record` returns a record untouched when it already fits, so halving
        a limit the record is nowhere near produces byte-identical output. When
        the CRITERIA are what overflowed — the loop does not shrink those — a
        3,000-character record against 25,000 characters of criteria sent the
        same 36,405-character prompt four times and paid for four rejections.
        """
        sent = []

        def always_overflows(prompt, system=main.SYSTEM_MESSAGE):
            sent.append(len(prompt))
            raise RuntimeError("provider returned HTTP 400: maximum context length exceeded")

        original = main._generate_structured_payload
        main._generate_structured_payload = always_overflows
        try:
            try:
                main._generate_with_shrink("x" * 3000, "y" * 25000)
            except RuntimeError:
                pass
            assert len(sent) == 1, f"re-sent an identical prompt {len(sent)} times"

            # A record that genuinely is too large must still walk the ladder.
            sent.clear()
            try:
                main._generate_with_shrink("x" * 130_000, "y" * 1000)
            except RuntimeError:
                pass
            assert len(sent) > 1, "an oversized record stopped shrinking too early"
            assert len(set(sent)) == len(sent), f"ladder repeated a size: {sent}"
        finally:
            main._generate_structured_payload = original

    def a_state_abbreviation_does_not_match_everything():
        """
        Site relevance matches on word starts, not bare substrings.

        Every US state has a two-letter form, so a substring test made the most
        ordinary input a wildcard: "Cleveland, OH" matched J-OH-annesburg,
        C-oh-asset and R-oh-nert Park, and because matches sort first,
        Johannesburg outranked Cleveland, Ohio for a search naming Cleveland.
        """
        def study(*rows):
            return {"protocolSection": {
                "identificationModule": {"nctId": "NCT1", "briefTitle": "t"},
                "contactsLocationsModule": {"locations": [
                    {"city": c, "state": st, "country": k, "status": "RECRUITING"}
                    for c, st, k in rows]}}}

        subject = study(
            ("Johannesburg", "Gauteng", "South Africa"),
            ("Rohnert Park", "California", "United States"),
            ("Cohasset", "Massachusetts", "United States"),
            ("Cleveland", "Ohio", "United States"),
        )
        for query in ("Cleveland, OH", "OH", "Ohio"):
            first = main._summarize_study(subject, query)["locations"][0]
            assert first == "Cleveland, Ohio", f"{query!r} surfaced {first!r}"

        # The count must include sites that are near AND open. Splitting the
        # buckets left it reporting only the not-yet-recruiting half, so a trial
        # whose every local site was open reported zero nearby.
        assert main._summarize_study(subject, "Ohio")["nearby_count"] == 1

    def the_service_binds_to_loopback():
        """
        No authentication, clinical text, and a metered budget: all three were
        exposed to the local network by a default of 0.0.0.0. CORS does not
        help — it constrains browsers, and the exposure is any HTTP client.
        """
        from pathlib import Path
        launcher = Path(main.__file__).read_text().split('if __name__ == "__main__"')[-1]
        assert '"0.0.0.0"' not in launcher.replace('os.environ.get("HOST", "127.0.0.1")', ""), \
            "the dev launcher binds every interface"
        assert "127.0.0.1" in launcher, "no loopback default in the launcher"

    def a_distant_site_is_still_found():
        """
        Site relevance must scan every location, not just the displayed few.

        The display list was capped at 120 entries BEFORE the relevance sort, so
        on a 372-site study a search for "Tokyo, Japan" returned "Fullerton,
        California" — the twenty Japanese sites all sat beyond the slice. The one
        fact the clinician needs, that the study is reachable, was exactly what
        the cap removed.

        No network: the study is synthesised so the matching site is deliberately
        placed past where the old code stopped looking.
        """
        locations = [
            {"city": f"City{i}", "state": "Texas", "country": "United States",
             "status": "RECRUITING"}
            for i in range(200)
        ]
        # Two sites in Japan, far beyond the old 120-entry cut-off.
        locations.insert(150, {"city": "Machida", "country": "Japan",
                               "status": "NOT_YET_RECRUITING"})
        locations.insert(151, {"city": "Kurume", "country": "Japan",
                               "status": "RECRUITING"})
        study = {
            "protocolSection": {
                "identificationModule": {"nctId": "NCT00000001", "briefTitle": "T"},
                "contactsLocationsModule": {"locations": locations},
            }
        }

        shown = main._summarize_study(study, "Tokyo, Japan")["locations"]
        assert shown, "no locations returned"
        assert "Japan" in shown[0], f"nearest site is not in Japan: {shown[:3]}"
        # An open site outranks one that has not opened yet: a clinician cannot
        # walk a patient into a site that is NOT_YET_RECRUITING today.
        assert shown[0] == "Kurume, Japan", shown[:3]
        assert "Machida, Japan" in shown, "the not-yet-open site was dropped entirely"
        # And the true total is still reported, not the displayed count.
        assert main._summarize_study(study, "Tokyo, Japan")["site_count"] == 202

    def derived_keywords_reach_the_registry():
        """
        The model is asked for "biomarkers, mutations, stage" and returns them in
        `keywords`. They were computed on every discovery run and never used.

        The cost was invisible because the scoring was RIGHT: a Stage IV patient
        searched as plain "non-small cell lung cancer" got early-stage and
        adjuvant trials, which were then correctly marked BLOCKED. A page of
        confident, accurate, useless rejections — the failure mode an eval that
        only checks verdicts cannot see.

        No network: this checks the wiring, not the registry.
        """
        import ast
        import inspect
        from pathlib import Path

        # The search accepts them...
        signature = inspect.signature(main._search_recruiting_trials)
        assert "keywords" in signature.parameters, signature

        # ...and the endpoint actually passes them.
        source = Path(main.__file__).read_text()
        tree = ast.parse(source)
        call = next(
            (
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and "_search_recruiting_trials" in ast.unparse(node)
                and any("search_keywords" in ast.unparse(a) for a in node.args)
            ),
            None,
        )
        assert call is not None, "_search_recruiting_trials is called without keywords"

        # And they are defined BEFORE the branch that derives them, because a
        # caller-supplied condition skips that branch entirely. Two bugs of this
        # exact shape have shipped from this file already.
        # `_run_discovery`, not the route: the pipeline was extracted so a
        # streaming endpoint could share it, and this check has to follow the
        # code rather than the URL.
        pipeline = next(
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "_run_discovery"
        )
        body = ast.unparse(pipeline)
        assigned_at = body.index("search_keywords")
        guard_at = body.index("if not search_condition")
        assert assigned_at < guard_at, "search_keywords is assigned after it is read"

    def an_over_specific_condition_still_finds_trials():
        """
        The registry indexes disease NAMES, not case descriptions.

        Measured live: 'non-small cell lung cancer' returns 12 recruiting studies,
        'stage IV KRAS G12C-mutated non-small cell lung carcinoma' returns 3, and
        'metastatic non-small cell lung carcinoma, adenocarcinoma subtype' returns
        ZERO. The model derives the condition from the record, so it phrases it
        clinically — and a zero-result search reads to the clinician as a patient
        with no options rather than as a query the registry could not parse.

        No network here: this checks the ladder, not the registry.
        """
        for condition, expected in (
            ("metastatic non-small cell lung carcinoma, adenocarcinoma subtype",
             "non-small cell lung carcinoma"),
            ("stage IV KRAS G12C-mutated non-small cell lung carcinoma",
             "non-small cell lung carcinoma"),
            ("newly diagnosed osteosarcoma of the distal femur", "osteosarcoma"),
        ):
            ladder = main._condition_ladder(condition)
            assert ladder[0] == condition, "the model's own phrasing must be tried first"
            assert expected in ladder, f"{condition!r} never broadens to {expected!r}: {ladder}"

        # An already-broad condition must not be mangled into something else.
        assert main._condition_ladder("breast cancer") == ["breast cancer"]

        # And the payload has to be able to admit a dropped location filter.
        assert "location_relaxed" in main.DiscoveryPayload.model_fields

    def discovery_reads_less_than_adjudication():
        """
        /api/discover sends the record ONCE PER TRIAL, so its cap is multiplied by
        the shortlist: at four trials the adjudication cap costs ~158k tokens a
        run against ~98k at the screening cap. The two endpoints get separate
        budgets because they answer different questions.

        Whatever the caps are, head-and-tail must keep the most recent block at
        BOTH — that is the property the split must not quietly break.
        """
        import inspect

        assert main.DISCOVERY_MAX_RECORD_CHARS <= main.MAX_PDF_CHARS
        # The fan-out must pass its own cap; inheriting the default is the bug.
        assert "DISCOVERY_MAX_RECORD_CHARS" in inspect.getsource(main._score_one_trial)

        record = "HEAD: diagnosis" + ("\nfiller note.\n" * 20_000) + "TAIL: KRAS G12C"
        for cap in (main.DISCOVERY_MAX_RECORD_CHARS, main.MAX_PDF_CHARS):
            fitted = main._fit_record(record, cap)
            assert "TAIL: KRAS G12C" in fitted, f"tail dropped at cap {cap}"
            assert "HEAD: diagnosis" in fitted, f"head dropped at cap {cap}"

    def only_context_overflows_are_retried_smaller():
        """
        Sending less text fixes a context overflow and nothing else.

        The provider chain reports failures as one concatenated message, so a
        naive substring test sees a context phrase from one provider and shrinks
        even when another was rate-limited or unauthorised — spending a second
        full round of quota on a request that was never going to be admitted.
        """
        shrinkable = "All 2 providers failed — a: maximum context length exceeded | b: request too large"
        assert main._looks_like_context_overflow(shrinkable)

        for message in (
            "All 2 providers failed — a: no room for this request | b: rate limit reached (HTTP 429)",
            "All 2 providers failed — a: context window exceeded | b: returned HTTP 401",
            "All 1 providers failed — b: truncated its response at the 8192-token ceiling.",
        ):
            assert not main._looks_like_context_overflow(message), message

    def truncation_keeps_the_end_of_the_chart():
        """
        Charts are truncated head-and-tail, not as a plain prefix.

        Measured on a 127,769-character chart of serial oncology notes: a plain
        `text[:40_000]` kept visits 1-19 and dropped the molecular tumour board
        summary at the end, so the KRAS G12C result the chart states explicitly
        came back UNKNOWN. Both ends are kept because charts disagree on
        chronology and the diagnosis header is nearly always at the top.
        """
        head_marker = "DIAGNOSIS: stage IV NSCLC"
        tail_marker = "KRAS G12C detected"
        record = head_marker + ("\nroutine interval note, no change.\n" * 4000) + tail_marker
        assert len(record) > main.MAX_PDF_CHARS

        fitted = main._fit_record(record)
        assert len(fitted) == main.MAX_PDF_CHARS, len(fitted)
        assert head_marker in fitted, "diagnosis header was dropped"
        assert tail_marker in fitted, "most recent block was dropped"
        # The seam must be announced, or two distant notes read as consecutive.
        assert main._ELISION.strip() in fitted
        # A record that fits is returned untouched — no marker, no reshaping.
        assert main._fit_record("short") == "short"

    def read_timeout_leaves_room_to_think():
        """
        These responses are not streamed, so the socket read gap IS the model's
        whole generation time and the read timeout is a hard ceiling on thinking.

        Measured on a real discovery run: Cloudflare answered at 55.8s and 56.2s
        and hit ReadTimeout three times at 60.1s, losing one trial and forcing
        retries that took the run from 79s to 179s. The floor below is what stops
        the value drifting back down toward observed generation times.
        """
        connect, read = main.LLM_TIMEOUT_SECONDS
        assert connect < read, (connect, read)
        assert read >= 90, f"read timeout {read}s is inside observed generation times"
        # asyncio.wait_for is the real ceiling; a read timeout above it would mean
        # the tuple never gets to bound anything.
        assert read < main.LLM_TOTAL_TIMEOUT_SECONDS, (read, main.LLM_TOTAL_TIMEOUT_SECONDS)

    def a_cut_off_response_is_not_a_success():
        """
        A provider that stops at its token ceiling returns HTTP 200 with half a
        JSON object. That used to count as a success, so the provider chain
        stopped there and the run died at the parse instead of failing over to a
        provider with a bigger budget. Both spellings of the field are checked
        because the two wire formats disagree.
        """
        import ast
        from pathlib import Path

        source = Path(main.__file__).read_text()
        body = next(
            n
            for n in ast.walk(ast.parse(source))
            if isinstance(n, ast.FunctionDef) and n.name == "_call_one_provider"
        )
        text = ast.unparse(body)
        for needle in ("finish_reason", "length", "stop_reason", "max_tokens"):
            assert needle in text, f"_call_one_provider no longer checks {needle!r}"
        # And the check must RAISE, not log: only an exception advances the chain.
        assert "truncated its response" in text

    def truncation_is_reported():
        notice = main.TruncationNotice(
            record_truncated=True, record_chars_used=40_000, record_chars_total=120_000
        )
        assert notice.record_truncated is True
        # And the field exists on both response contracts, defaulting to honest.
        for model in (main.ClinixPathPayload, main.DiscoveryPayload):
            assert "truncation" in model.model_fields, model.__name__

    def a_stated_reset_window_is_waited_out():
        """
        A 429 carries the reset the provider named, and the retry honours it.

        The number was living only inside the message string: Groq answered
        "resets in about 18 seconds" and `_score_one_trial` slept a flat 2.0, so
        the retry hit the same closed window. Three of four trials on a measured
        run failed that way and every one scored fine when re-sent by hand.
        """
        limited = main.ProviderRateLimited("groq rate limit reached", retry_after=18)
        assert main._retry_after_of(limited) == 18

        # It has to survive the chain's aggregate, which is what the retry sees.
        aggregate = RuntimeError("All 2 configured providers failed — groq: ...")
        aggregate.retry_after = 18
        assert main._retry_after_of(aggregate) == 18

        # And the prose form, for an error re-wrapped on the way up.
        assert main._retry_after_of(
            RuntimeError("groq rate limit reached (HTTP 429). Resets in about 7 seconds.")
        ) == 7

        # A DAILY cap reports no wait: no single run outlasts one.
        assert main._retry_after_of(RuntimeError("no numbers here")) == 0

        # And the delay must GROW with what was asked for. Asserting the source
        # does not say `sleep(2.0)` was too weak — it passed against a rewrite
        # that assigned 2.0 to a variable first. This tests the behaviour.
        assert main._retry_delay(18) == 18, "a stated 18s wait is not honoured"
        assert main._retry_delay(0) == 2.0, "no stated wait should still pause"
        assert main._retry_delay(3) == 3
        # Capped, so an hours-long daily cap cannot stall a run.
        assert main._retry_delay(9999) == main.MAX_RETRY_WAIT_SECONDS
        # Never past the run's remaining budget.
        assert main._retry_delay(18, remaining=5) == 5
        assert main._retry_delay(18, remaining=-1) <= 0, "a spent budget must not sleep"

        # Three attempts, because one retry inside a ~20s refill window is one
        # retry spent on a bucket that has not refilled yet.
        assert main.RETRIES_PER_TRIAL >= 3, main.RETRIES_PER_TRIAL

        # The loop has to actually call it.
        import ast
        from pathlib import Path

        body = next(
            n
            for n in ast.walk(ast.parse(Path(main.__file__).read_text()))
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "_score_one_trial"
        )
        text = ast.unparse(body)
        assert "_retry_after_of" in text, "_score_one_trial ignores the stated wait"
        assert "_retry_delay" in text, "_score_one_trial no longer sizes its own wait"

    def one_call_per_bucket_is_not_run_two_at_a_time():
        """
        Concurrency cannot exceed what the surviving chain can actually admit.

        A provider declaring `tpm_limit` is charged prompt + max_tokens at
        request time, and the reservation is sized to whatever is left of the
        bucket — so one call books all of it and a second is refused, not
        queued. Running two against such a chain manufactures its own 429s.
        """
        real = main._provider_chain
        try:
            main._provider_chain = lambda: [{"name": "groq", "tpm_limit": "8000"}]
            assert main._effective_concurrency() == 1, "a TPM-only chain must serialize"

            # A provider with headroom lifts it again.
            main._provider_chain = lambda: [
                {"name": "groq", "tpm_limit": "8000"},
                {"name": "cloudflare"},
            ]
            assert main._effective_concurrency() == main.DISCOVERY_CONCURRENCY
        finally:
            main._provider_chain = real

    def an_exhausted_provider_is_stood_down():
        """
        A spent DAILY allowance drops out of the chain instead of being redialled.

        Cloudflare answers an exhausted free tier with a plain 429 whose body
        says "daily free allocation". Every trial in a run was paying a full
        round-trip to be told that again, and runs hit their time budget with
        trials still unscored because of it.
        """
        main._EXHAUSTED_UNTIL.clear()
        try:
            main._mark_exhausted("cloudflare", 3600)
            assert "cloudflare" in main._EXHAUSTED_TODAY
            assert "cloudflare" not in [p["name"] for p in main._provider_chain()]

            # It comes BACK once the window passes — a stand-down is not a ban.
            main._EXHAUSTED_UNTIL["cloudflare"] = main.time.monotonic() - 1
            assert "cloudflare" not in main._EXHAUSTED_TODAY

            # With EVERY provider out, the chain must not come back empty: there
            # would be no call to make and so no error to show the clinician.
            for name in [p["name"] for p in main._provider_chain()]:
                main._mark_exhausted(name, 3600)
            assert main._provider_chain(), "an all-exhausted chain went empty"
        finally:
            main._EXHAUSTED_UNTIL.clear()

        # Both wordings of a spent daily allowance are recognised. Groq says
        # "tokens per day (TPD)" and Cloudflare says "daily free allocation";
        # testing only for "daily" missed Groq and cost 20s of sleep an attempt.
        class _Resp:
            def __init__(self, body, headers=None):
                self.text = body
                self.headers = headers or {}

            def json(self):
                raise ValueError("not json")

        assert main._is_daily_cap(_Resp("Rate limit reached ... on tokens per day (TPD)"))
        assert main._is_daily_cap(_Resp("used up your daily free allocation of 10,000 neurons"))
        assert main._is_daily_cap(_Resp("", {"x-ratelimit-type": "tokens_per_day"}))
        # A per-MINUTE bucket must not be mistaken for one: it is waitable.
        assert not main._is_daily_cap(_Resp("Rate limit reached on tokens per minute (TPM)"))

    def studies_found_but_unscored_is_not_no_match():
        """
        "Nothing matched" and "nothing could be scored" are different answers.

        The page showed "No recruiting trials matched — try widening the
        location" for a San Jose search that found four studies and lost all
        four to a spent model quota. Widening the location cannot fix a quota,
        so the advice pointed at the one thing that was not wrong.
        """
        assert main._summarize_failures([], 4) == ""

        quota = main._summarize_failures(
            ["NCT1 (RuntimeError: groq rate limit reached (HTTP 429), daily cap)"], 4
        )
        assert "quota" in quota.lower() and "1 of 4 studies" in quota

        minute = main._summarize_failures(
            ["NCT1 (RuntimeError: groq rate limit reached (HTTP 429))"], 4
        )
        assert "per-minute" in minute and "Screen more trials" in minute

        registry = main._summarize_failures(
            ["NCT1 (HTTPError: 500 for url: https://clinicaltrials.gov/api/v2/x)"], 2
        )
        assert "ClinicalTrials.gov" in registry

        # Never a bare count with no cause, whatever the error was.
        catchall = main._summarize_failures(["NCT1 (ValueError: something odd)"], 3)
        assert len(catchall) > 40, catchall

        # The field has to exist for any of it to reach the browser.
        assert "failure_summary" in main.DiscoveryPayload.model_fields

    def an_all_out_chain_says_so_in_one_sentence():
        """
        A chain where every provider failed the same way collapses to one line.

        The aggregate is written for a log and lands verbatim in a dialog: ~600
        characters, two reset windows and two copies of "Set LLM_PROVIDER in
        backend/.env", around the single fact that there is no model capacity
        until a quota resets.
        """
        # Verbatim from a measured run, because the length is the whole point.
        both_daily = RuntimeError(
            "All 2 configured providers failed — groq: groq rate limit reached "
            "(HTTP 429). Resets in about 24 minutes. This is a per-model daily "
            "cap, so a different provider gives a fresh allowance immediately. "
            "Configured and still usable: cloudflare. Set LLM_PROVIDER in "
            "backend/.env. | cloudflare: cloudflare rate limit reached (HTTP "
            "429). Resets in an unknown period. This is a per-model daily cap, "
            "so a different provider gives a fresh allowance immediately. Every "
            "configured provider is out for today; add another key to "
            "backend/.env, or wait for the reset."
        )
        condensed = main._condense_chain_error(both_daily)
        assert len(condensed) < len(str(both_daily)) / 2, len(condensed)
        assert "today" in condensed and "backend/.env" in condensed
        # None of the log-shaped detail survives into the dialog.
        assert "HTTP 429" not in condensed and "LLM_PROVIDER" not in condensed

        both_minute = RuntimeError(
            "All 2 configured providers failed — groq: groq rate limit reached "
            "(HTTP 429). tokens per minute | cloudflare: rate limit reached, "
            "tokens per minute"
        )
        assert "about a minute" in main._condense_chain_error(both_minute)

        # A MIXED chain keeps its detail: that is what makes it diagnosable.
        mixed = RuntimeError(
            "All 2 configured providers failed — groq: groq rate limit reached "
            "(HTTP 429). daily | cloudflare: cloudflare returned HTTP 401: bad key"
        )
        assert "401" in main._condense_chain_error(mixed)

        # And a single-provider error is passed through untouched.
        solo = RuntimeError("groq returned HTTP 401: invalid api key")
        assert main._condense_chain_error(solo) == str(solo)

    def spend_is_capped_per_caller():
        """
        The metered endpoints are rate-limited, and the limit cannot be spoofed.

        CORS is not a guard: it is enforced by browsers, so a deployed instance
        with a public URL, no authentication and a metered model key is one
        `curl` loop away from a spent balance.

        The forwarding header is the part that is easy to get wrong. Each proxy
        APPENDS the peer it saw, so the RIGHTMOST entry is written by
        infrastructure; the leftmost is whatever the caller claimed. A limiter
        that keys on the leftmost hands out a fresh allowance to anyone willing
        to change one header per request, which is worse than no limiter at all
        because it looks like protection.
        """
        class Req:
            def __init__(self, xff=None, host="9.9.9.9"):
                self.headers = {"x-forwarded-for": xff} if xff else {}
                self.client = type("C", (), {"host": host})()

        assert main._client_ip(Req()) == "9.9.9.9"
        assert main._client_ip(Req("203.0.113.7")) == "203.0.113.7"
        assert main._client_ip(Req("1.2.3.4, 203.0.113.7")) == "203.0.113.7", (
            "a forged leading hop is being trusted"
        )

        saved_limit = main.RATE_LIMIT_REQUESTS
        saved_cap = main.RATE_LIMIT_MAX_TRACKED
        try:
            main.RATE_LIMIT_REQUESTS = 3
            main._rate_buckets.clear()
            assert [main._over_rate_limit("a") for _ in range(5)] == [
                False, False, False, True, True,
            ]
            # A second caller has its own allowance.
            assert main._over_rate_limit("b") is False

            # Changing only the forged hop must NOT buy a fresh allowance.
            main._rate_buckets.clear()
            spoofed = [
                main._over_rate_limit(main._client_ip(Req(f"10.0.0.{i}, 203.0.113.7")))
                for i in range(5)
            ]
            assert spoofed == [False, False, False, True, True], spoofed

            # And the table cannot be grown without bound by varying the address.
            main.RATE_LIMIT_MAX_TRACKED = 50
            main._rate_buckets.clear()
            for i in range(500):
                main._over_rate_limit(f"ip-{i}")
            assert len(main._rate_buckets) <= 50, len(main._rate_buckets)
        finally:
            main.RATE_LIMIT_REQUESTS = saved_limit
            main.RATE_LIMIT_MAX_TRACKED = saved_cap
            main._rate_buckets.clear()

        # The platform's own health check must never be throttled, or the service
        # fails its probe and is restarted into a loop.
        assert "/health" not in main._METERED_PATHS
        for path in ("/api/discover", "/api/discover/stream", "/api/analyze"):
            assert path in main._METERED_PATHS, path

    def a_failure_summary_quotes_no_provider_text():
        """
        The sentence shown to a clinician is built from OUR phrases, never theirs.

        `failed` carries raw exception text. A summary that echoed it would put
        a provider's response body — and on the search path, the derived query
        with the patient's biomarkers in it — onto the page.
        """
        secret = "PD-L1 65% KRAS G12C stage IV adenocarcinoma"
        summary = main._summarize_failures(
            [f"NCT1 (HTTPError: 500 for url: https://x/?query.term={secret})"], 1
        )
        for leak in ("PD-L1", "KRAS", "G12C", "adenocarcinoma", "query.term"):
            assert leak not in summary, f"{leak!r} leaked into {summary!r}"

    return [
        ("empty matrix is not a pass", empty_matrix_is_not_a_pass),
        ("a stated reset window is waited out", a_stated_reset_window_is_waited_out),
        ("one call per bucket is not run two at a time", one_call_per_bucket_is_not_run_two_at_a_time),
        ("an exhausted provider is stood down", an_exhausted_provider_is_stood_down),
        ("studies found but unscored is not no match", studies_found_but_unscored_is_not_no_match),
        ("an all-out chain says so in one sentence", an_all_out_chain_says_so_in_one_sentence),
        ("spend is capped per caller", spend_is_capped_per_caller),
        ("a failure summary quotes no provider text", a_failure_summary_quotes_no_provider_text),
        ("JSON survives a preamble", json_survives_a_preamble),
        ("malformed JSON still fails", malformed_json_still_fails),
        ("internal hosts are unreachable", internal_hosts_are_unreachable),
        ("every model call is time-bounded", every_model_call_is_time_bounded),
        ("truncation keeps the end of the chart", truncation_keeps_the_end_of_the_chart),
        ("shrinking stops when it changes nothing", shrinking_stops_when_it_changes_nothing),
        ("a state abbreviation does not match everything", a_state_abbreviation_does_not_match_everything),
        ("the service binds to loopback", the_service_binds_to_loopback),
        ("a distant site is still found", a_distant_site_is_still_found),
        ("derived keywords reach the registry", derived_keywords_reach_the_registry),
        ("an over-specific condition still finds trials", an_over_specific_condition_still_finds_trials),
        ("discovery reads less than adjudication", discovery_reads_less_than_adjudication),
        ("only context overflows are retried smaller", only_context_overflows_are_retried_smaller),
        ("read timeout leaves room to think", read_timeout_leaves_room_to_think),
        ("a cut-off response is not a success", a_cut_off_response_is_not_a_success),
        ("truncation is reported", truncation_is_reported),
    ]
