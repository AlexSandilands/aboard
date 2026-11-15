import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";
import { PAIRING_CODE_TTL_MS } from "./machineAuth.ts";

const board = (name = "bridge") => ({ instanceId: randomUUID(), name });

function setup() {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const h = createTestHarness({ role: "runner", integrations: { now: () => now } });
  return {
    h,
    auth: h.services.machineAuth,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};

describe("machine pairing", () => {
  it("trades a code for a token once, storing neither in the clear", () => {
    const { h, auth } = setup();
    const { code } = auth.createPairingCode();
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const bridge = board();
    const { token, tokenId } = auth.pair({ code, board: bridge });
    expect(auth.verify(token)).toMatchObject({ tokenId, board: bridge });
    expect(codeOf(() => auth.pair({ code, board: bridge }))).toBe("VALIDATION");

    const stored = JSON.stringify([
      h.db.prepare("SELECT * FROM machine_tokens").all(),
      h.db.prepare("SELECT * FROM machine_pairing_codes").all(),
    ]);
    expect(stored).not.toContain(token.split(".")[1]);
    expect(stored).not.toContain(code.replaceAll("-", ""));
  });

  it("takes a code as it is typed: lower case, spaces, no dashes", () => {
    const { auth } = setup();
    const { code } = auth.createPairingCode();
    const typed = ` ${code.replaceAll("-", " ").toLowerCase()} `;
    expect(auth.pair({ code: typed, board: board() }).token).toBeTruthy();
  });

  it("refuses an expired code and one replaced by a newer code", () => {
    const { auth, advance } = setup();
    const expired = auth.createPairingCode();
    advance(PAIRING_CODE_TTL_MS + 1);
    expect(codeOf(() => auth.pair({ code: expired.code, board: board() }))).toBe("VALIDATION");

    const first = auth.createPairingCode();
    const second = auth.createPairingCode();
    expect(codeOf(() => auth.pair({ code: first.code, board: board() }))).toBe("VALIDATION");
    expect(auth.pair({ code: second.code, board: board() }).token).toBeTruthy();
  });

  it("stops taking codes after too many wrong ones, for a minute", () => {
    const { auth, advance } = setup();
    const { code } = auth.createPairingCode();
    for (let i = 0; i < 10; i++)
      expect(codeOf(() => auth.pair({ code: "AAAA-AAAA-AAAA", board: board() }))).toBe("VALIDATION");
    // Even the right code is refused now, so guessing can't go faster than ten a minute.
    expect(() => auth.pair({ code, board: board() })).toThrow(/Too many/);
    advance(61_000);
    expect(auth.pair({ code, board: board() }).token).toBeTruthy();
  });

  it("refuses a second board, without spending the code", () => {
    const { auth } = setup();
    const bridge = board("bridge");
    auth.pair({ code: auth.createPairingCode().code, board: bridge });
    const { code } = auth.createPairingCode();
    expect(codeOf(() => auth.pair({ code, board: board("intruder") }))).toBe("CONFLICT");
    expect(auth.pairings().map((p) => p.board.name)).toEqual(["bridge"]);
    // The paired board can still use it, and pairing again replaces its token.
    const before = auth.pairings()[0]!.tokenId;
    const again = auth.pair({ code, board: bridge });
    expect(auth.pairings().map((p) => p.tokenId)).toEqual([again.tokenId]);
    expect(again.tokenId).not.toBe(before);
  });

  it("rejects malformed, unknown and tampered tokens", () => {
    const { auth } = setup();
    const { token, tokenId } = auth.pair({ code: auth.createPairingCode().code, board: board() });
    for (const bad of [
      "",
      "nodot",
      ".",
      `${tokenId}.`,
      `${tokenId}.wrong`,
      `other.${token.split(".")[1]}`,
      `${token}x`,
    ]) {
      expect([bad, auth.verify(bad)]).toEqual([bad, null]);
    }
  });

  it("revokes one token or all, and a revoked token stops working at once", () => {
    const { auth } = setup();
    const { token, tokenId } = auth.pair({ code: auth.createPairingCode().code, board: board() });
    expect(auth.paired()).toBe(true);
    expect(auth.revoke("nope")).toBe(false);
    expect(auth.revoke(tokenId)).toBe(true);
    expect(auth.verify(token)).toBeNull();
    expect(auth.paired()).toBe(false);

    // Unpaired, another board may pair.
    const next = auth.pair({ code: auth.createPairingCode().code, board: board("other") });
    const pending = auth.createPairingCode();
    expect(auth.revokeAll()).toBe(1);
    expect(auth.verify(next.token)).toBeNull();
    expect(codeOf(() => auth.pair({ code: pending.code, board: board() }))).toBe("VALIDATION");
  });

  it("records when a token was last used, at most once a minute", () => {
    const { auth, advance } = setup();
    const { token } = auth.pair({ code: auth.createPairingCode().code, board: board() });
    expect(auth.pairings()[0]!.lastUsedAt).toBeNull();
    auth.verify(token);
    const first = auth.pairings()[0]!.lastUsedAt;
    expect(first).not.toBeNull();
    advance(30_000);
    auth.verify(token);
    expect(auth.pairings()[0]!.lastUsedAt).toBe(first);
    advance(31_000);
    auth.verify(token);
    expect(auth.pairings()[0]!.lastUsedAt).not.toBe(first);
  });
});
