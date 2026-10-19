import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { stuckHeight } from "./stuck.logic";

/**
 * Whether a pinned lane is stuck under the column header, in the board's scroll box (`data-board-scroll`), and how
 * far it has folded up. It sticks as soon as its top reaches the header, and from there gives up one pixel of height
 * per pixel scrolled down to its settled height (`maxVh` of the window, or its one-line cards if they take less), so
 * its bottom stays on the lanes under it: no gap opens and nothing jumps, either way.
 *
 * `spacerRef` (an element just after the lane) takes up what the lane gave up. The lane's height and the spacer's are
 * always set together, with nothing measured in between, so the lanes under them never move, not even for one layout:
 * if they did, the browser's scroll anchoring would scroll the board to follow them. This hook styles the lane and the
 * spacer; give them no `style`.
 *
 * The full height can't be read while stuck (the cards are one line then), so it is the last one seen unstuck: tasks
 * added or removed while stuck leave the lane off by the change until it unsticks.
 *
 * Attach `beforeRef` (a marker just before the lane), `sectionRef`, `bodyRef` (the part of the lane that scrolls
 * inside it while stuck) and `spacerRef`.
 */
export function useStuck(pinned: boolean, headerRef: RefObject<HTMLElement | null>, maxVh: number) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [stuckNow, setStuck] = useState(false);
  const stuck = pinned && stuckNow;
  // Whether the cards on screen are the one-line ones: until React has swapped them back, the lane holds its height.
  const renderedStuck = useRef(false);
  const update = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const before = beforeRef.current;
    const section = sectionRef.current;
    const body = bodyRef.current;
    const spacer = spacerRef.current;
    const root = before?.closest<HTMLElement>("[data-board-scroll]");
    if (!pinned || !before || !section || !body || !spacer || !root) return;
    let natural = section.offsetHeight;
    // The one-line cards' height, once they have been seen.
    let compact = Infinity;
    let current = false;
    const setHeights = (height: number | null) => {
      section.style.height = height === null ? "" : `${height}px`;
      // Clip rather than hide, so the lane's header still sticks to the board's left edge.
      section.style.overflow = height === null ? "" : "clip";
      spacer.style.height = `${height === null ? 0 : Math.max(0, natural - height)}px`;
    };
    // Run straight from the scroll event, not a frame later, so the lane and the lanes under it move together.
    const run = () => {
      const rootTop = root.getBoundingClientRect().top + (headerRef.current?.offsetHeight ?? 0);
      const scrolled = rootTop - before.getBoundingClientRect().top;
      const cards = body.firstElementChild as HTMLElement | null;
      if (scrolled > 0 && renderedStuck.current && cards) {
        compact = section.offsetHeight - body.clientHeight + cards.offsetHeight;
      }
      const height = stuckHeight({ natural, scrolled, settled: Math.min(compact, (window.innerHeight * maxVh) / 100) });
      if (height !== null) setHeights(height);
      else if (renderedStuck.current) setHeights(natural);
      else {
        setHeights(null);
        natural = section.offsetHeight;
      }
      if ((height !== null) !== current) {
        current = height !== null;
        setStuck(current);
      }
    };
    update.current = run;
    run();
    const observer = new ResizeObserver(run);
    observer.observe(section);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    root.addEventListener("scroll", run, { passive: true });
    window.addEventListener("resize", run);
    return () => {
      root.removeEventListener("scroll", run);
      window.removeEventListener("resize", run);
      observer.disconnect();
      update.current = () => {};
      setHeights(null);
      // Unpinned, or the board remounting: nothing is stuck.
      setStuck(false);
    };
  }, [pinned, headerRef, maxVh]);

  useLayoutEffect(() => {
    renderedStuck.current = stuck;
    // Stuck: measure the one-line cards. Unstuck and showing full cards again: let go of the held height.
    update.current();
  }, [stuck]);

  return { beforeRef, sectionRef, bodyRef, spacerRef, stuck };
}
