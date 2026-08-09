/* Hallmark · theme: CUSTOM "Protocol" (dual-band) · genre: modern-minimal
 *
 * This stamp has now been wrong twice — it read "Cobalt" after the project moved
 * to "Chart", then "Chart" after the move to "Protocol". A stamp that lies is
 * worse than none, because the next run reads it and rebuilds toward a system
 * that was already rejected. tokens.css is the source of truth; if you change
 * the theme there, change this line in the same commit.
 *
 * Every colour here resolves to a token in tokens.css. Nothing in this file is a
 * literal. The band flips by swapping `data-theme` on <html>, so any hard-coded
 * hex would survive the flip and break one of the two modes.
 *
 * `tok()` wraps each token so Tailwind's opacity modifiers keep working: a bare
 * `var(--x)` cannot be alpha-composited, so `bg-accent/15` would silently no-op.
 * color-mix gives us real alpha in the OKLCH space the tokens are authored in.
 */
const tok =
  (name) =>
  ({ opacityValue }) => {
    // Tailwind calls this twice per colour, and NEITHER call passes a clean number:
    //   · base utility   -> the STRING "var(--tw-text-opacity)"
    //   · `/75` modifier -> the STRING "0.75"
    // Feeding the first into color-mix yields `calc(var(--tw-text-opacity) * 100%)`,
    // invalid at computed-value time; the browser drops the declaration entirely
    // and the element silently inherits. So: parse it, and only build a color-mix
    // when a real number comes out.
    const alpha = Number.parseFloat(opacityValue);
    if (!Number.isFinite(alpha)) return `var(${name})`;
    return `color-mix(in oklch, var(${name}) ${alpha * 100}%, transparent)`;
  };

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', ':root[data-theme="dark"] &'],
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        paper: {
          DEFAULT: tok('--color-paper'),
          2: tok('--color-paper-2'),
          3: tok('--color-paper-3'),
          inset: tok('--color-paper-inset'),
        },
        ink: {
          DEFAULT: tok('--color-ink'),
          2: tok('--color-ink-2'),
          3: tok('--color-ink-3'),
        },
        rule: {
          DEFAULT: tok('--color-rule'),
          strong: tok('--color-rule-strong'),
        },
        accent: {
          DEFAULT: tok('--color-accent'),
          hover: tok('--color-accent-hover'),
          soft: tok('--color-accent-soft'),
          ink: tok('--color-accent-ink'),
        },
        ok: { DEFAULT: tok('--color-ok'), soft: tok('--color-ok-soft') },
        risk: { DEFAULT: tok('--color-risk'), soft: tok('--color-risk-soft') },
        gap: { DEFAULT: tok('--color-gap'), soft: tok('--color-gap-soft') },
        hold: { DEFAULT: tok('--color-hold'), soft: tok('--color-hold-soft') },
        band: {
          DEFAULT: tok('--color-band'),
          ink: tok('--color-band-ink'),
          2: tok('--color-band-ink-2'),
          rule: tok('--color-band-rule'),
        },
        violet: { DEFAULT: tok('--color-violet'), soft: tok('--color-violet-soft') },
        focus: tok('--color-focus'),
      },
      fontSize: {
        xs: 'var(--text-xs)',
        sm: 'var(--text-sm)',
        base: 'var(--text-base)',
        lg: 'var(--text-lg)',
        xl: 'var(--text-xl)',
        '2xl': 'var(--text-2xl)',
        '3xl': 'var(--text-3xl)',
        'display-s': 'var(--text-display-s)',
        display: 'var(--text-display)',
      },
      spacing: {
        '2xs': 'var(--space-2xs)',
        xs: 'var(--space-xs)',
        sm: 'var(--space-sm)',
        md: 'var(--space-md)',
        lg: 'var(--space-lg)',
        xl: 'var(--space-xl)',
        '2xl': 'var(--space-2xl)',
        '3xl': 'var(--space-3xl)',
      },
      // Only DEFAULT is declarable here: Tailwind reads `border-t-<name>` as a
      // colour, so named widths silently resolve to 0. Components reference the
      // rule scale with `border-t-[length:var(--rule-page)]` instead.
      borderWidth: { DEFAULT: 'var(--rule)' },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        // Was defined in tokens.css and unmapped here, so `rounded-xl` silently
        // resolved to Tailwind's own 0.75rem instead of the token.
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        lift: 'var(--shadow-lift)',
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
      },
      letterSpacing: {
        display: 'var(--track-display)',
        tightish: 'var(--track-tight)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        in: 'var(--ease-in)',
        'in-out': 'var(--ease-in-out)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        mid: 'var(--dur-mid)',
        slow: 'var(--dur-slow)',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // The one attention move, reserved for a blocking exclusion. Opacity only,
        // no scale, no bounce; a clinical readout should not wobble.
        'pulse-attention': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.62' },
        },
      },
      animation: {
        'rise-in': 'rise-in var(--dur-slow) var(--ease-out) both',
        'fade-in': 'fade-in var(--dur-mid) var(--ease-out) both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-attention': 'pulse-attention 2.4s var(--ease-in-out) infinite',
      },
    },
  },
  plugins: [],
};
