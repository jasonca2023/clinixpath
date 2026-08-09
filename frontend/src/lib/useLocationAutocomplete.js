import { useState, useCallback, useRef, useEffect } from "react";

// Read from the environment, never inlined here. A literal in this file is a
// literal in the published bundle AND in a public repository: this key was
// committed and pushed, so it must be treated as burned and rotated — removing
// it from HEAD does not remove it from the branch history that already carries
// it.
//
// Geoapify keys are client-side by design (the browser has to send one), so the
// real protection is a domain restriction plus the daily quota on the key
// itself. An unrestricted key in a public repo has neither, and the quota is
// what runs out first.
//
// Absent, the hook already degrades to no suggestions — see the guard below —
// so a clone with no key gets a plain text field rather than a broken one.
const API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY ?? "";

export function useLocationAutocomplete(value) {
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const debounceTimer = useRef(null);
  const loadingTimer = useRef(null);
  const abortControllerRef = useRef(null);

  const fetchSuggestions = useCallback(
    async (query) => {
      if (!query.trim() || !API_KEY) {
        setSuggestions([]);
        setIsOpen(false);
        setIsLoading(false);
        return;
      }

      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      setIsLoading(true);
      setIsOpen(true);
      try {
        const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(query)}&apiKey=${API_KEY}&format=json`;
        const response = await fetch(url, {
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const results = data.results || [];

        const seen = new Set();
        const formatted = results
          .map((item) => ({
            id: `${item.lat}-${item.lon}`,
            label:
              item.address_line1 ||
              `${item.city || ""}${item.country ? ", " + item.country : ""}`.trim(),
            display: formatDisplay(item),
            lat: item.lat,
            lon: item.lon,
          }))
          .filter((item) => {
            if (!item.label || seen.has(item.display)) return false;
            seen.add(item.display);
            return true;
          })
          .slice(0, 8);

        setSuggestions(formatted);
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Geoapify autocomplete error:", error);
          setSuggestions([]);
        }
      } finally {
        clearTimeout(loadingTimer.current);
        loadingTimer.current = setTimeout(() => {
          setIsLoading(false);
        }, 300);
      }
    },
    [API_KEY],
  );

  useEffect(() => {
    if (!value.trim()) {
      clearTimeout(debounceTimer.current);
      clearTimeout(loadingTimer.current);
      setIsLoading(false);
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    clearTimeout(debounceTimer.current);
    clearTimeout(loadingTimer.current);
    debounceTimer.current = setTimeout(() => {
      fetchSuggestions(value);
    }, 50);

    return () => {
      clearTimeout(debounceTimer.current);
      clearTimeout(loadingTimer.current);
    };
  }, [value, fetchSuggestions]);

  const selectSuggestion = useCallback((suggestion) => {
    setIsOpen(false);
    return suggestion.display;
  }, []);

  const closeSuggestions = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    suggestions,
    isLoading,
    isOpen,
    selectSuggestion,
    closeSuggestions,
  };
}

function formatDisplay(item) {
  const parts = [];
  if (item.city) parts.push(item.city);
  if (item.country) parts.push(item.country);
  if (!item.city && !item.country && item.address_line1)
    return item.address_line1;
  return parts.join(", ");
}
