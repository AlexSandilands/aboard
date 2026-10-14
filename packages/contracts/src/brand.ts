import pkg from "../../../package.json" with { type: "json" };

/**
 * Product identity, read from the root package.json (`name`, `displayName`, `version`). Everything that names the
 * product — env vars, data dir, MCP server name, storage keys, UI title — derives from here, so a
 * rename is a package.json edit.
 */
export const BRAND = {
  /** Lowercase id: MCP server name, data dir, storage keys, temp-dir prefixes. */
  id: pkg.name,
  /** Display name for UI and agent-facing text. */
  name: pkg.displayName,
  version: pkg.version,
} as const;

/** Environment variable name, e.g. `brandEnv("HOME")` → `ABOARD_HOME`. */
export const brandEnv = (key: string): string => `${BRAND.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${key}`;

/** Namespaced browser storage key, e.g. `storageKey("theme")` → `aboard:theme`. */
export const storageKey = (key: string): string => `${BRAND.id}:${key}`;

/** Header REST clients use to say which agent made a write. */
export const ACTOR_HEADER = `x-${BRAND.id}-actor`;
