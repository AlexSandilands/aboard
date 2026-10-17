/**
 * Timeout for a test that runs real processes (git, a shell, a CLI). Each one costs 0.2s to several seconds to
 * start on a busy Windows machine (antivirus scans, other workers), so a test that runs a dozen needs far more
 * than vitest's default. The limit only matters when something hangs, so it is generous.
 */
export const PROCESS_TEST_TIMEOUT = 120_000;
