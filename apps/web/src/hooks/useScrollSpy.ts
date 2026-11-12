import { type RefObject, useEffect } from "react";
import { useStableCallback } from "./useStableCallback";
import { activeSectionId, isScrolledToBottom } from "./scrollSpy.logic";

/**
 * Scroll-spy over a scroll area: reports the id (the value of `attribute`) of the element being read among those
 * inside `area` that carry `attribute`, whenever it may have changed, and null once the area unmounts. Settings and
 * Stats use it to highlight their rail.
 */
export function useScrollSpy(
  areaRef: RefObject<HTMLElement | null>,
  attribute: string,
  onActive: (id: string | null) => void,
): void {
  const report = useStableCallback(onActive);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = area.getBoundingClientRect().top;
      const sections = Array.from(area.querySelectorAll<HTMLElement>(`[${attribute}]`), (element) => ({
        id: element.getAttribute(attribute) ?? "",
        top: element.getBoundingClientRect().top - top,
      }));
      report(activeSectionId(sections, { atBottom: isScrolledToBottom(area) }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    area.addEventListener("scroll", schedule, { passive: true });
    // Sections grow as their data loads, which moves the ones below without a scroll event.
    const observer = new ResizeObserver(schedule);
    if (area.firstElementChild) observer.observe(area.firstElementChild);
    schedule();
    return () => {
      area.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
      report(null);
    };
  }, [areaRef, attribute, report]);
}

/** Runs `fn` once a smooth scroll in `area` has come to rest, or after a moment where `scrollend` isn't fired. */
export function afterScroll(area: HTMLElement, fn: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    area.removeEventListener("scrollend", run);
    fn();
  };
  const timer = setTimeout(run, 900);
  area.addEventListener("scrollend", run);
  return () => {
    done = true;
    clearTimeout(timer);
    area.removeEventListener("scrollend", run);
  };
}
