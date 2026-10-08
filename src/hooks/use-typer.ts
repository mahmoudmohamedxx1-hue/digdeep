"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reveals `target` progressively, like Perplexity's streaming answers.
 * - When the target grows in chunks (live drafts arriving), it types out the
 *   new part quickly but readably, adapting speed to the backlog.
 * - When `enabled` is false the full text shows instantly (completed reports).
 * - When the target shrinks (switched runs), it snaps to the new text.
 * - `skip()` jumps straight to the full text ("skip typing" affordance).
 * All state updates happen inside requestAnimationFrame callbacks (never
 * synchronously in effects), keeping the React compiler happy.
 */
export function useTyper(target: string, enabled = true) {
  const [len, setLen] = useState(() => (enabled ? 0 : target.length));
  const lenRef = useRef(len);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      if (!enabled || target.length < lenRef.current) {
        // disabled → show everything; shrank → snap to the new text
        if (lenRef.current !== target.length) {
          lenRef.current = target.length;
          setLen(target.length);
        }
        return;
      }
      if (lenRef.current < target.length) {
        const backlog = target.length - lenRef.current;
        const speed = 60 + Math.min(2600, backlog * 7); // chars/sec — fast catch-up, gentle finish
        lenRef.current = Math.min(target.length, lenRef.current + Math.max(1, Math.round(speed * 0.016)));
        setLen(lenRef.current);
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [target, enabled]);

  const skip = useCallback(() => {
    lenRef.current = target.length;
    setLen(target.length);
  }, [target]);

  const effectiveLen = Math.min(len, target.length);
  return { text: target.slice(0, effectiveLen), typing: enabled && effectiveLen < target.length, skip };
}
