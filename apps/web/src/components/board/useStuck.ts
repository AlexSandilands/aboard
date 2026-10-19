import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isStuck } from "./stuck.logic";

/**
 * Whether a pinned lane is stuck under the column header, found with a sentinel (a zero-height element placed where
 * the lane would be unpinned) that an IntersectionObserver watches against the area below the header, in the board's
 * scroll box (`data-board-scroll`).
 *
 * Going stuck shrinks the lane, which would shorten the board and, near its bottom, clamp the scroll position back
 * until the lane unsticks and grows again: a flicker. So while stuck, `spacerRef` (an empty element at the end of the
 * board's content, which this hook styles; give it no `style`) is given just the height that keeps the scroll position
 * the lane stuck at reachable, usually none, and the scroll position is put back if the shorter board clamped it. It
 * is at the end, and not the lane's whole lost height after the lane, so no gap shows between the lane and the
 * projects. Attach `sentinelRef` and `sectionRef`.
 */
export function useStuck(
  pinned: boolean,
  headerRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLDivElement | null>,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [stuckNow, setStuck] = useState(false);
  const stuck = pinned && stuckNow;
  // The scroll position when the sentinel went out of view.
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
    const root = section.closest<HTMLElement>("[data-board-scroll]");
    const fill = () => {
      if (!stuck || !root) {
        spacer.style.height = "0px";
        return;
      }
      // How far the board scrolls without the spacer, against how far it had to for the lane to stick.
      const reachable = root.scrollHeight - spacer.offsetHeight - root.clientHeight;
      spacer.style.height = `${Math.max(0, scrollAtStick.current - reachable)}px`;
    };
    fill();
    // The shorter lane may already have clamped the scroll position; the spacer gives the room back.
    if (stuck && root && root.scrollTop < scrollAtStick.current) root.scrollTop = scrollAtStick.current;
    const observer = new ResizeObserver(fill);
    observer.observe(section);
    return () => {
      observer.disconnect();
      spacer.style.height = "0px";
    };
  }, [pinned, stuck, spacerRef]);

  return { sentinelRef, sectionRef, stuck };
}
