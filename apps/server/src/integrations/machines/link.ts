import type { MachineConnection, MachineDescriptor, MachineRoute, MachineRouteState } from "@repo/contracts";
import { messageOf } from "../util.ts";
import type { OpenRoute, RouteHandle } from "./tunnel.ts";

// One machine's connection (docs/features/remote-machines.md#routes): its routes tried in order, the first that
// works used, a failed one retried with a growing wait, and a better one moved back to when it returns.

/** What answered on a route: the machine expected, and whether the board may talk to it. */
export interface LinkProbe {
  state: Extract<MachineConnection, "connected" | "needs-update" | "unpaired">;
  descriptor: MachineDescriptor;
}

export interface LinkState {
  connection: MachineConnection;
  /** Why it isn't connected; null when it is. */
  error: string | null;
  activeRoute: number | null;
  routeStates: MachineRouteState[];
}

export interface MachineLink {
  state(): LinkState;
  /** The URL the machine answers at now; null when no route works. */
  url(): string | null;
  /** Checks now, trying every route again whatever its wait. Resolves when the pass is over. */
  check(): Promise<void>;
  close(): void;
}

export interface LinkDeps {
  routes: readonly MachineRoute[];
  open: OpenRoute;
  /**
   * Who answers at `url`. Throws when it is nobody, or not the machine expected (the message is shown); resolves
   * for the machine itself, whether or not it can be talked to.
   */
  probe(url: string): Promise<LinkProbe>;
  /** After every change of state. */
  onChange(state: LinkState): void;
  /** After each pass in which the machine answered, with the URL it answered at. */
  onReached?(probe: LinkProbe, url: string): void | Promise<void>;
  now?: () => number;
}

/** How often a working connection is checked, and a better route than the one in use is tried. */
export const LINK_CHECK_INTERVAL_MS = 30_000;
const RETRY_BASE_MS = 2_000;
/** The longest wait between tries of a route that keeps failing. */
export const LINK_RETRY_MAX_MS = 5 * 60_000;

/** The wait before try `failures + 1` of a route: 2s, 4s, 8s, … up to five minutes. */
export const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), LINK_RETRY_MAX_MS);

const UNPAIRED = "It no longer accepts this board. Pair it again with a new code.";
const NEEDS_UPDATE = "It runs a version this board can't talk to until it is updated.";

export function createMachineLink(deps: LinkDeps): MachineLink {
  const now = deps.now ?? Date.now;
  const routes = deps.routes;
  const failures = routes.map(() => 0);
  const retryAt = routes.map(() => 0);
  const errors = routes.map((): string | null => null);
  let connecting: number | null = null;
  let active: { index: number; handle: RouteHandle; probe: LinkProbe } | null = null;
  let tried = false;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let last = "";

  const state = (): LinkState => {
    const routeStates = routes.map((_, i): MachineRouteState => {
      if (active?.index === i) return { status: "active", error: null, retryAt: null };
      if (connecting === i) return { status: "connecting", error: errors[i] ?? null, retryAt: null };
      if (errors[i] != null) {
        return { status: "failed", error: errors[i] ?? null, retryAt: new Date(retryAt[i] ?? 0).toISOString() };
      }
      return { status: "standby", error: null, retryAt: null };
    });
    if (active) {
      const connection = active.probe.state;
      return {
        connection,
        error: connection === "unpaired" ? UNPAIRED : connection === "needs-update" ? NEEDS_UPDATE : null,
        activeRoute: active.index,
        routeStates,
      };
    }
    // The preferred route's reason is the one worth reading; the others usually fail for it too.
    const error = errors.find((e) => e != null) ?? null;
    return { connection: tried ? "unreachable" : "connecting", error, activeRoute: null, routeStates };
  };

  const emit = () => {
    const next = state();
    const key = JSON.stringify(next);
    if (key === last) return;
    last = key;
    deps.onChange(next);
  };

  const drop = (error: string) => {
    if (!active) return;
    const { index, handle } = active;
    active = null;
    handle.close();
    errors[index] = error;
    // Tried again at once: a route that just worked has most likely only blinked.
    failures[index] = 0;
    retryAt[index] = 0;
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    let delay = LINK_CHECK_INTERVAL_MS;
    if (!active) {
      const next = Math.min(...retryAt.map((at) => at));
      delay = Math.max(1_000, Math.min(next - now(), LINK_RETRY_MAX_MS));
    }
    timer = setTimeout(() => void run(false), delay);
    timer.unref();
  };

  /** A route that ends by itself (its ssh exited) is replaced at once, not at the next check. */
  async function watch(handle: RouteHandle): Promise<void> {
    await handle.ended;
    if (active?.handle !== handle || closed) return;
    drop("The tunnel closed");
    emit();
    void run(false);
  }

  async function pass(force: boolean): Promise<void> {
    if (active) {
      const current = active;
      try {
        current.probe = await deps.probe(current.handle.url);
      } catch (error) {
        if (active === current) drop(messageOf(error));
      }
    }
    // Every route when none works; only the better ones when one does.
    const limit = active ? active.index : routes.length;
    for (let i = 0; i < limit; i++) {
      const route = routes[i];
      if (closed) break;
      if (!route || (!force && (retryAt[i] ?? 0) > now())) continue;
      connecting = i;
      emit();
      let handle: RouteHandle | null = null;
      try {
        handle = await deps.open(route);
        const probe = await deps.probe(handle.url);
        if (closed) {
          handle.close();
          return;
        }
        active?.handle.close();
        const opened = handle;
        active = { index: i, handle: opened, probe };
        failures[i] = 0;
        retryAt[i] = 0;
        errors[i] = null;
        void watch(opened);
        connecting = null;
        break;
      } catch (error) {
        handle?.close();
        failures[i] = (failures[i] ?? 0) + 1;
        retryAt[i] = now() + retryDelayMs(failures[i] ?? 1);
        errors[i] = messageOf(error);
      }
      connecting = null;
    }
    connecting = null;
    tried = true;
    emit();
    if (active && !closed) {
      try {
        await deps.onReached?.(active.probe, active.handle.url);
      } catch {
        // What the board does with a reached machine fails by itself; the connection stands.
      }
    }
  }

  /** One pass at a time; a call during one waits for it, then runs its own. */
  function run(force: boolean): Promise<void> {
    const start = async () => {
      if (closed) return;
      try {
        await pass(force);
      } finally {
        schedule();
      }
    };
    const next = (running ?? Promise.resolve()).then(start);
    const tracked = next.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
  }

  void run(false);

  return {
    state,
    url: () => active?.handle.url ?? null,
    check: () => run(true),
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      active?.handle.close();
      active = null;
    },
  };
}
