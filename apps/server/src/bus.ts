import type { BoardEvent } from "@taskboard/contracts";

type Listener = (event: BoardEvent) => void;

/** In-process pub/sub for board changes. Services publish after commit; SSE and pollers subscribe. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(event: BoardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[bus] listener failed", error);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
