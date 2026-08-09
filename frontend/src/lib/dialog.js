import { useEffect, useRef } from "react";

/**
 * Modal behaviour shared by every dialog in the app.
 *
 * The three dialogs here (redaction review, source viewer, terms gate) each grew
 * their own Escape handler and their own initial `focus()` call, and none of them
 * did the other two things a modal owes the user:
 *
 *   FOCUS TRAP. Without one, Tab walks straight out of the dialog and into the page
 *   behind it — which is still fully interactive to a keyboard or screen-reader
 *   user while `aria-modal="true"` tells them it is not. That matters most in
 *   RedactionReview, where the thing behind the scrim is the button that sends
 *   patient text to a third party.
 *
 *   SCROLL LOCK. The body scrolls under an open dialog, so dismissing it returns
 *   the reader somewhere they did not choose.
 *
 * Focus is also restored to whatever opened the dialog, so closing does not dump a
 * keyboard user back at the top of the document.
 *
 * @param {boolean} open
 * @param {() => void} onClose  called on Escape
 * @returns {React.RefObject<HTMLElement>} attach to the dialog container
 */
export function useDialog(open, onClose) {
  const containerRef = useRef(null);
  const restoreFocusTo = useRef(null);

  // The close handler lives in a ref so the effect below can depend on `open`
  // ALONE. Every call site passes an inline arrow (`onClose={() => setX(null)}`),
  // which is a new function identity on every parent render — so an effect that
  // depended on it tore down and re-ran constantly while the dialog was open.
  // That did not just churn: on each re-setup it re-captured
  // `restoreFocusTo.current` from `document.activeElement`, which by then is an
  // element INSIDE the dialog. The "return focus to whatever opened this"
  // guarantee destroyed itself after the first re-render, and RedactionReview
  // re-renders on every keystroke, so it always hit.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    restoreFocusTo.current = document.activeElement;

    // Reserve the scrollbar's width as padding, or removing it shifts the whole
    // page sideways the instant the dialog opens.
    const { overflow, paddingRight } = document.body.style;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;

    const focusable = () =>
      Array.from(
        containerRef.current?.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
        // A control inside a collapsed disclosure is in the DOM but not on screen;
        // trapping focus onto it would strand the user on something invisible.
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) {
        // Nothing to move to; keep focus on the container rather than losing it.
        event.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !containerRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      // Only if the caller has not deliberately moved focus somewhere else.
      const target = restoreFocusTo.current;
      if (target && typeof target.focus === "function" && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  return containerRef;
}

export default useDialog;
