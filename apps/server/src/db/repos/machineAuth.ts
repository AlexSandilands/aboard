import type { Sql } from "./sql.ts";

export interface MachineTokenRecord {
  id: string;
  secretHash: string;
  boardInstanceId: string;
  boardName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokenRow {
  id: string;
  secret_hash: string;
  board_instance_id: string;
  board_name: string;
  created_at: string;
  last_used_at: string | null;
}

const tokenOf = (r: TokenRow): MachineTokenRecord => ({
  id: r.id,
  secretHash: r.secret_hash,
  boardInstanceId: r.board_instance_id,
  boardName: r.board_name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

/** Typed access to a runner's pairing codes and paired boards' tokens, both stored hashed. */
export function createMachineAuthRepo(sql: Sql) {
  return {
    addCode(codeHash: string, createdAt: string, expiresAt: string): void {
      sql.run(
        "INSERT INTO machine_pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)",
        codeHash,
        createdAt,
        expiresAt,
      );
    },
    /** Deletes the code and says whether it was there and still valid at `now`: a code works once. */
    takeCode(codeHash: string, now: string): boolean {
      const row = sql.get<{ expires_at: string }>(
        "DELETE FROM machine_pairing_codes WHERE code_hash = ? RETURNING expires_at",
        codeHash,
      );
      return row !== undefined && row.expires_at > now;
    },
    deleteExpiredCodes(now: string): void {
      sql.run("DELETE FROM machine_pairing_codes WHERE expires_at <= ?", now);
    },
    deleteCodes(): void {
      sql.run("DELETE FROM machine_pairing_codes");
    },
    tokens(): MachineTokenRecord[] {
      return sql.all<TokenRow>("SELECT * FROM machine_tokens ORDER BY created_at, id").map(tokenOf);
    },
    token(id: string): MachineTokenRecord | null {
      const row = sql.get<TokenRow>("SELECT * FROM machine_tokens WHERE id = ?", id);
      return row ? tokenOf(row) : null;
    },
    addToken(t: MachineTokenRecord): void {
      sql.insert("machine_tokens", {
        id: t.id,
        secret_hash: t.secretHash,
        board_instance_id: t.boardInstanceId,
        board_name: t.boardName,
        created_at: t.createdAt,
        last_used_at: t.lastUsedAt,
      });
    },
    touchToken(id: string, at: string): void {
      sql.run("UPDATE machine_tokens SET last_used_at = ? WHERE id = ?", at, id);
    },
    /** How many rows went. */
    deleteToken(id: string): number {
      return Number(sql.run("DELETE FROM machine_tokens WHERE id = ?", id).changes);
    },
    deleteTokensOfBoard(boardInstanceId: string): number {
      return Number(sql.run("DELETE FROM machine_tokens WHERE board_instance_id = ?", boardInstanceId).changes);
    },
    deleteTokens(): number {
      return Number(sql.run("DELETE FROM machine_tokens").changes);
    },
  };
}
