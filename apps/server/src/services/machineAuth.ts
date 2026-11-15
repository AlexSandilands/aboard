import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { PairMachineInput, PairedBoard } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";

// A runner's side of pairing (docs/features/remote-machines.md#pairing, ADR 0015): one-time codes made on the
// runner itself, exchanged once for a token the board keeps. Only hashes are stored.

/** How long a pairing code works. Long enough to type it into the board, short enough that a leaked one is stale. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes one address may send per minute before its exchanges are refused for the rest of it. */
const MAX_FAILURES_PER_MINUTE = 10;
const FAILURE_WINDOW_MS = 60 * 1000;
/** `last_used_at` is for the user to read, so it is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000;

// No 0/O or 1/I/L, so a code read aloud or retyped can't be got wrong. 12 of 31 symbols is 59 bits.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 12;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A code as typed: any case, with or without the dashes. */
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

function newCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A board paired with this runner, as `pair list` shows it. Never carries the token. */
export interface MachinePairing {
  tokenId: string;
  board: PairedBoard;
  pairedAt: string;
  lastUsedAt: string | null;
}

export interface MachineAuthService {
  /**
   * A new one-time pairing code, shown once: `XXXX-XXXX-XXXX`, good for `PAIRING_CODE_TTL_MS`. It replaces any code
   * still outstanding, so only the newest one printed works.
   */
  createPairingCode(): { code: string; expiresAt: string };
  /**
   * Exchanges a pairing code for a token, returned this once. A board pairing again replaces its earlier token.
   * Throws VALIDATION for a code that is wrong, used or expired (or after too many wrong ones from `peer`, the
   * address asking), and CONFLICT when another board is paired: a runner serves one board, and the code stays
   * usable by the board that is.
   */
  pair(input: PairMachineInput, peer?: string | null): { token: string; tokenId: string };
  /** The pairing a token belongs to, or null for one that is malformed, unknown or revoked. */
  verify(token: string): MachinePairing | null;
  pairings(): MachinePairing[];
  /** Whether any board is paired. */
  paired(): boolean;
  /** Revokes one token by id; false when there is none. */
  revoke(tokenId: string): boolean;
  /** Revokes every token and outstanding code; returns how many tokens went. */
  revokeAll(): number;
}

export function createMachineAuthService(core: Pick<Core, "repos" | "now" | "write">): MachineAuthService {
  const repo = core.repos.machineAuth;
  /**
   * When each address last sent wrong codes, so one that guesses can't shut out the board with the right code.
   * Everyone behind a tunnel or proxy is one address. In memory: a restart forgives them all.
   */
  const failures = new Map<string, number[]>();

  const pairingOf = (t: {
    id: string;
    boardInstanceId: string;
    boardName: string;
    createdAt: string;
    lastUsedAt: string | null;
  }): MachinePairing => ({
    tokenId: t.id,
    board: { instanceId: t.boardInstanceId, name: t.boardName },
    pairedAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
  });

  return {
    createPairingCode() {
      const now = core.now();
      const code = newCode();
      const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
      core.write(() => {
        repo.deleteCodes();
        repo.addCode(sha256(code), now.toISOString(), expiresAt);
      });
      return { code: code.replace(/(.{4})(?=.)/g, "$1-"), expiresAt };
    },

    pair({ code, board }, peer) {
      const now = core.now();
      for (const [address, times] of failures) {
        const recent = times.filter((at) => at > now.getTime() - FAILURE_WINDOW_MS);
        if (recent.length > 0) failures.set(address, recent);
        else failures.delete(address);
      }
      const from = peer ?? "";
      if ((failures.get(from)?.length ?? 0) >= MAX_FAILURES_PER_MINUTE) {
        throw new AppError("VALIDATION", "Too many wrong pairing codes. Wait a minute and try again.");
      }
      return core.write(() => {
        if (!repo.takeCode(sha256(normalizeCode(code)), now.toISOString())) {
          failures.set(from, [...(failures.get(from) ?? []), now.getTime()]);
          throw new AppError("VALIDATION", "That pairing code is wrong, already used or expired.");
        }
        const other = repo.tokens().find((t) => t.boardInstanceId !== board.instanceId);
        if (other) {
          // Thrown inside the write, so the code is not spent on a board that can't have it.
          throw new AppError(
            "CONFLICT",
            `This machine is already paired with another board (${other.boardName}). Unpair it on this machine first.`,
          );
        }
        repo.deleteTokensOfBoard(board.instanceId);
        const id = randomBytes(9).toString("base64url");
        const secret = randomBytes(32).toString("base64url");
        repo.addToken({
          id,
          secretHash: sha256(secret),
          boardInstanceId: board.instanceId,
          boardName: board.name,
          createdAt: now.toISOString(),
          lastUsedAt: null,
        });
        return { token: `${id}.${secret}`, tokenId: id };
      });
    },

    verify(token) {
      const dot = token.indexOf(".");
      if (dot <= 0) return null;
      const record = repo.token(token.slice(0, dot));
      if (!record) return null;
      const given = Buffer.from(sha256(token.slice(dot + 1)), "hex");
      const stored = Buffer.from(record.secretHash, "hex");
      if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
      const now = core.now();
      if (!record.lastUsedAt || now.getTime() - Date.parse(record.lastUsedAt) > TOUCH_INTERVAL_MS) {
        record.lastUsedAt = now.toISOString();
        core.write(() => repo.touchToken(record.id, now.toISOString()));
      }
      return pairingOf(record);
    },

    pairings: () => repo.tokens().map(pairingOf),
    paired: () => repo.tokens().length > 0,
    revoke: (tokenId) => core.write(() => repo.deleteToken(tokenId) > 0),
    revokeAll: () =>
      core.write(() => {
        repo.deleteCodes();
        return repo.deleteTokens();
      }),
  };
}
