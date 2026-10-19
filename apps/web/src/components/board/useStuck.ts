import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isStuck } from "./stuck.logic";

/**
 * Whether a pinned lane is stuck under the column header, found with a sentinel (a zero-height element placed where
 * the lane would be unpinned) that an IntersectionObserver watches against the area below the header, in the board's
 * scroll box (`data-board-scroll`).
 *
 * Going stuck shrinks the lane, which would shorten the board and, near its bottom, clamp the scroll position back
 * until the lane unsticks and grows again: a flicker. So the lane's footprint is kept while it is stuck: `spacerRef`
 * is an element after the lane whose height this hook sets to what the lane gave up, and the scroll position is put
 * back if the shorter board clamped it. Attach `sentinelRef`, `sectionRef` and `spacerRef`; `spacerRef` is only ever
 * styled here, so give it no `style`.
 */
export function useStuck(pinned: boolean, headerRef: RefObject<HTMLElement | null>) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [stuckNow, setStuck] = useState(false);
  const stuck = pinned && stuckNow;
  // The lane's height while it isn't stuck, and the scroll position when the sentinel went out of view.
  const naturalHeight = useRef(0);
  const scrollAtStick = useRef(0);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = sentinel?.closest<HTMLElement>("[data-board-scroll]");
    if (!pinned || !sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]!;
        scrollAtStick.current = root.scrollTop;
        setStuck(
          isStuck({
            isIntersecting: entry.isIntersecting,
            top: entry.boundingClientRect.top,
            rootTop: entry.rootBounds?.top ?? 0,
          }),
        );
      },
      // The visible area starts under the column header.
      { root, rootMargin: `-${headerRef.current?.offsetHeight ?? 0}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      // Unpinned, or the board remounting: nothing is stuck, and a stick seen earlier mustn't move the scroll later.
      setStuck(false);
      scrollAtStick.current = 0;
    };
  }, [pinned, headerRef]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const spacer = spacerRef.current;
    if (!pinned || !section || !spacer) return;
    const fill = () => {
      spacer.style.height = stuck ? `${Math.max(0, naturalHeight.current - section.offsetHeight)}px` : "0px";
    };
    if (stuck) {
      // The shorter lane may already have clamped the scroll position; the spacer gives the room back.
      const root = section.closest<HTMLElement>("[data-board-scroll]");
      fill();
      if (root && root.scrollTop < scrollAtStick.current) root.scrollTop = scrollAtStick.current;
    } else {
      fill();
      naturalHeight.current = section.offsetHeight;
    }
    const observer = new ResizeObserver(() => {
      if (!stuck) naturalHeight.current = section.offsetHeight;
      fill();
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [pinned, stuck]);

  return { sentinelRef, sectionRef, spacerRef, stuck };
}
