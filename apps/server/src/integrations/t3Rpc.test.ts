import { describe, expect, it } from "vitest";
import type { FetchFn } from "./t3.ts";
import { fakeSocket, success } from "../test/fakeT3Socket.ts";
import { failureToError, openT3Rpc, T3RpcError } from "./t3Rpc.ts";

const ORIGIN = "http://127.0.0.1:3773";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ticketFetch =
  (status = 200): FetchFn =>
  async (url, init) => {
    expect(url).toBe(`${ORIGIN}/api/auth/websocket-ticket`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
    return status === 200 ? json({ ticket: "tic ket", expiresAt: "x" }) : json({}, status);
  };

describe("openT3Rpc", () => {
  it("connects with a ticket and resolves requests from Exit frames", async () => {
    const socket = fakeSocket((frame) => success(frame.id, { echo: frame.tag }));
    const rpc = await openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: socket.open });
    expect(socket.url).toBe("ws://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket=tic%20ket");
    expect(await rpc.request("server.getConfig", {})).toEqual({ echo: "server.getConfig" });
    expect(socket.sent[0]).toEqual({ _tag: "Request", id: "1", tag: "server.getConfig", payload: {}, headers: [] });
    rpc.close();
    expect(socket.closed).toBe(true);
  });

  it("maps typed failures and defects", async () => {
    const socket = fakeSocket((frame) => ({
      _tag: "Exit",
      requestId: frame.id,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: { _tag: "EnvironmentAuthorizationError", message: "no", requiredScope: "orchestration:operate" },
          },
        ],
      },
    }));
    const rpc = await openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: socket.open });
    await expect(rpc.request("orchestration.launchThread", {})).rejects.toMatchObject({
      kind: "forbidden",
      message: "The T3 Code token lacks the orchestration:operate scope",
    });
  });

  it("reports a rejected token and an unreachable socket", async () => {
    await expect(
      openT3Rpc({
        origin: ORIGIN,
        token: "tok",
        fetch: ticketFetch(401),
        openSocket: fakeSocket(() => undefined).open,
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(
      openT3Rpc({
        origin: ORIGIN,
        token: "tok",
        fetch: ticketFetch(),
        openSocket: fakeSocket(() => undefined, false).open,
      }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("answers each request from a batched array of frames", async () => {
    const socket = fakeSocket(() => undefined);
    const rpc = await openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: socket.open });
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    socket.emit("message", [success("2", "second"), success("1", "first")]);
    expect(await Promise.all([a, b])).toEqual(["first", "second"]);
  });

  it("fails pending requests at once when the socket closes or T3 sends a session defect", async () => {
    const closing = fakeSocket(() => undefined);
    const rpc = await openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: closing.open });
    const pending = rpc.request("server.getConfig", {});
    closing.emit("close");
    await expect(pending).rejects.toMatchObject({ kind: "unreachable", message: "T3 Code closed the connection" });
    await expect(rpc.request("again", {})).rejects.toMatchObject({ kind: "unreachable" });

    const defect = fakeSocket(() => undefined);
    const rpc2 = await openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: defect.open });
    const waiting = rpc2.request("server.getConfig", {});
    defect.emit("message", { _tag: "Defect", defect: "Malformed message" });
    await expect(waiting).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("Malformed message"),
    });
    expect(defect.closed).toBe(true);
  });

  it("closes the socket when the handshake fails", async () => {
    const socket = fakeSocket(() => undefined, false);
    await expect(
      openT3Rpc({ origin: ORIGIN, token: "tok", fetch: ticketFetch(), openSocket: socket.open }),
    ).rejects.toMatchObject({ kind: "unreachable" });
    expect(socket.closed).toBe(true);
  });

  it("times out a request with no reply", async () => {
    const socket = fakeSocket(() => undefined);
    const rpc = await openT3Rpc({
      origin: ORIGIN,
      token: "tok",
      fetch: ticketFetch(),
      openSocket: socket.open,
      timeoutMs: 20,
    });
    await expect(rpc.request("server.getConfig", {})).rejects.toBeInstanceOf(T3RpcError);
  });
});

describe("failureToError", () => {
  it("keeps T3's message for typed failures and flags defects as protocol errors", () => {
    expect(
      failureToError([
        { _tag: "Fail", error: { _tag: "OrchestrationV2ThreadLaunchError", message: "Project not found." } },
      ]),
    ).toMatchObject({ kind: "failed", message: "Project not found." });
    expect(failureToError([{ _tag: "Die", defect: "Expected string" }])).toMatchObject({ kind: "protocol" });
  });
});
