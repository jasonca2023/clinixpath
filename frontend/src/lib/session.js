/**
 * Local session state: colour band + terms acceptance.
 *
 * Both live in localStorage and nowhere else. There is no account, no server-side
 * profile, and deliberately nothing here that identifies a person, consistent with
 * a tool whose whole claim is that patient data never leaves the device.
 */

const THEME_KEY = "clinixpath.theme";
const TERMS_KEY = "clinixpath.termsAcceptedAt";

// Bump when the terms change materially. That re-prompts everyone who accepted
// an older version, which is the entire point of versioning consent.
export const TERMS_VERSION = "2026.07";

const safeGet = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private mode / storage blocked
  }
};

const safeSet = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to do; the session simply won't persist */
  }
};

/* ---- colour band ------------------------------------------------------- */

/** The band actually in force right now, resolving OS preference when unset. */
export function resolveTheme() {
  const saved = safeGet(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

/** True when the user has made an explicit choice (vs. following the OS). */
export function hasExplicitTheme() {
  const saved = safeGet(THEME_KEY);
  return saved === "light" || saved === "dark";
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  safeSet(THEME_KEY, theme);
}

/* ---- terms ------------------------------------------------------------- */

/**
 * Terms are accepted once per browser, per terms version. A returning user goes
 * straight past the gate; a user who accepted an older version sees it again.
 */
export function hasAcceptedTerms() {
  const raw = safeGet(TERMS_KEY);
  if (!raw) return false;
  const [version] = raw.split("|");
  return version === TERMS_VERSION;
}

export function acceptTerms() {
  safeSet(TERMS_KEY, `${TERMS_VERSION}|${new Date().toISOString()}`);
}

export function acceptedAt() {
  const raw = safeGet(TERMS_KEY);
  if (!raw) return null;
  const [, iso] = raw.split("|");
  return iso ?? null;
}

/* ---- last run -----------------------------------------------------------
 *
 * A discovery run takes one to three minutes and costs a slice of a metered
 * daily budget, and until now a stray refresh threw the whole thing away.
 *
 * SESSION storage, not local. The saved payload contains extracted clinical
 * facts and quotes from the record — de-identified, but still the substance of
 * a chart. sessionStorage survives a reload and dies with the tab, which is the
 * behaviour that matches the promise on the front of this product: the data is
 * on your device for as long as you are looking at it, and then it is gone. A
 * localStorage copy would sit on disk until something explicitly cleared it.
 */
const RUN_KEY = "clinixpath.lastRun";

export function saveLastRun(run) {
  try {
    window.sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch {
    /* quota exceeded or storage blocked; the run is simply not restorable */
  }
}

export function loadLastRun() {
  try {
    const raw = window.sessionStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Shape-checked rather than trusted: a stale entry from an older build
    // would otherwise render as a broken console with no way to tell why.
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.result && !parsed.discovery) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLastRun() {
  try {
    window.sessionStorage.removeItem(RUN_KEY);
  } catch {
    /* nothing to do */
  }
}
