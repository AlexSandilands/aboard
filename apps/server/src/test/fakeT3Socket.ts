import type { SocketLike } from "../integrations/t3Rpc.ts";

export interface SentFrame {
  id: string;
  tag: string;
  payload: unknown;
}

/** In-memory socket: `reply` answers each request frame; `opens` controls the handshake. */
export function fakeSocket(reply: (frame: SentFrame) => unknown, opens = true) {
  const sent: SentFrame[] = [];
  const listeners: Record<string, Array<(event?: { data: unknown }) => void>> = {};
  let url = "";
  let closed = false;
  const socket: SocketLike = {
    send(data) {
      const frame = JSON.parse(data) as SentFrame;
      sent.push(frame);
      const response = reply(frame);
      if (response !== undefined) {
        queueMicrotask(() => listeners.message?.forEach((l) => l({ data: JSON.stringify(response) })));
      }
    },
    close() {
      closed = true;
    },
    addEventListener(type: string, listener: (event?: { data: unknown }) => void) {
      (listeners[type] ??= []).push(listener);
    },
  } as SocketLike;
  return {
    sent,
    get url() {
      return url;
    },
    get closed() {
      return closed;
    },
    /** Fires a socket event, e.g. `emit("close")` or `emit("message", frame)`. */
    emit: (type: string, frame?: unknown) =>
      listeners[type]?.forEach((l) => l(frame === undefined ? undefined : { data: JSON.stringify(frame) })),
    open: (u: string) => {
      url = u;
      queueMicrotask(() => listeners[opens ? "open" : "error"]?.forEach((l) => l()));
      return socket;
    },
  };
}

export const success = (id: string, value: unknown) => ({
  _tag: "Exit",
  requestId: id,
  exit: { _tag: "Success", value },
});
