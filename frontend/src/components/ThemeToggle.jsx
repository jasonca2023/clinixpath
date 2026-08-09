import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, resolveTheme } from "../lib/session.js";

/**
 * Two-state band switch.
 *
 * Deliberately a plain toggle, not a three-way light/dark/system picker: the OS
 * preference is already honoured until the user overrides it, and a third control
 * would be a setting most people never touch.
 */
export default function ThemeToggle({ className = "" }) {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    setTheme(resolveTheme());
  }, []);

  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md border border-rule text-ink-3 transition-colors duration-fast ease-out hover:border-accent hover:text-ink ${className}`}
    >
      <Icon className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}
