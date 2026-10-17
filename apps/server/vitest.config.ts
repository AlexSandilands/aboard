import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Windows starts processes slowly and the server suite starts many (git, shells, a fresh worker per file), so
// with a worker per core the tests starve each other and time out. Half the cores keeps it steady.
const limitWorkers = process.platform === "win32";

export default defineConfig({
  test: {
    // The default 5s is too tight for a test that opens a database and runs every migration when the machine is busy.
    // Tests that run real processes set their own limit (src/test/timeouts.ts).
    testTimeout: 15_000,
    hookTimeout: 30_000,
    ...(limitWorkers ? { maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)) } : {}),
  },
});
