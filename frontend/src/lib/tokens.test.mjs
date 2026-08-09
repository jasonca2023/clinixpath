/**
 * tokens.css consistency checks.
 *
 *     node src/lib/tokens.test.mjs
 *
 * WHY THIS EXISTS
 * The dark palette is declared TWICE — once for the explicit toggle
 * (`:root[data-theme='dark']`) and once for the OS preference
 * (`@media (prefers-color-scheme: dark) :root:not([data-theme])`). CSS has no way
 * to share a block between a selector and a media query, so the duplication is
 * structural.
 *
 * It drifted immediately. A full re-theme edited the toggle block and missed the
 * media block, so anyone whose OS was set to dark — which includes every headless
 * browser, and so every screenshot taken to review the work — still saw the OLD
 * palette. The redesign looked like it had not been applied at all.
 *
 * A comment saying "keep these identical" is what failed. This is the check that
 * does not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../tokens.css"), "utf8");

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error.message}`);
    failed += 1;
  }
};

/** Pull `--token: value;` pairs out of the block starting at `startIndex`. */
function declarationsAfter(startIndex) {
  if (startIndex < 0) throw new Error("block not found");
  const slice = css.slice(startIndex);
  const end = slice.indexOf("\n  }\n") >= 0 ? slice.indexOf("\n  }\n") : slice.indexOf("\n}\n");
  const body = slice.slice(0, end);
  const out = new Map();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.replace(/\s+/g, " ").trim());
  }
  return out;
}

check("the two dark palettes are identical", () => {
  const toggle = declarationsAfter(css.indexOf(":root[data-theme='dark'] {"));
  const media = declarationsAfter(css.indexOf(":root:not([data-theme]) {"));

  if (toggle.size === 0 || media.size === 0) {
    throw new Error(`empty block (toggle=${toggle.size}, media=${media.size})`);
  }

  const drifted = [];
  for (const [name, value] of toggle) {
    if (!media.has(name)) drifted.push(`${name}: missing from the media block`);
    else if (media.get(name) !== value) {
      drifted.push(`${name}: toggle=${value} vs media=${media.get(name)}`);
    }
  }
  for (const name of media.keys()) {
    if (!toggle.has(name)) drifted.push(`${name}: missing from the toggle block`);
  }

  if (drifted.length) {
    throw new Error(
      `${drifted.length} token(s) drifted between the dark blocks:\n      ` +
        drifted.join("\n      "),
    );
  }
});

check("no raw hex colours outside the print sheet", () => {
  // Every colour must resolve through a token so the band flip reaches it. The
  // print sheet is the documented exception and lives in its own file.
  const offenders = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  if (offenders.length) throw new Error(`hex literals in tokens.css: ${offenders.join(", ")}`);
});

check("the accent is not a saturated blue", () => {
  // The failure mode this whole re-theme exists to prevent: chroma above ~0.05 in
  // the 230-280 hue range is the generic clinical-dashboard blue.
  const light = declarationsAfter(css.indexOf(":root[data-theme='light'] {"));
  const accent = light.get("--color-accent") ?? "";
  const match = accent.match(/oklch\(\s*[\d.]+%\s+([\d.]+)\s+([\d.]+)/);
  if (!match) throw new Error(`could not parse --color-accent: ${accent}`);
  const [, chroma, hue] = match.map(Number);
  if (hue >= 230 && hue <= 280 && chroma > 0.05) {
    throw new Error(`accent is a saturated blue again (chroma ${chroma}, hue ${hue})`);
  }
});

console.log(failed ? `\n${failed} failed` : "\nall token checks passed");
process.exit(failed ? 1 : 0);
