import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, resolveTheme } from "../lib/session.js";

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

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className={`relative inline-flex h-9 w-16 items-center rounded-full ${className}`}
      style={{
        border: "1px solid var(--color-rule-strong)",
        backgroundColor: theme === "dark" ? "var(--color-paper-3)" : "var(--color-paper-2)",
        transition: "background-color var(--dur-mid) var(--ease-out)",
      }}
    >
      <div
        className="absolute flex h-8 w-8 items-center justify-center rounded-full"
        style={{
          left: theme === "dark" ? "calc(100% - 32px)" : "2px",
          backgroundColor: theme === "dark" ? "var(--color-paper-inset)" : "var(--color-paper)",
          transition: "left var(--dur-mid) var(--ease-out), background-color var(--dur-mid) var(--ease-out)",
        }}
      >
        {theme === "dark" ? (
          <Sun className="h-4 w-4" strokeWidth={2} style={{ color: "var(--color-ink)" }} />
        ) : (
          <Moon className="h-4 w-4" strokeWidth={2} style={{ color: "var(--color-ink-2)" }} />
        )}
      </div>
    </button>
  );
}
