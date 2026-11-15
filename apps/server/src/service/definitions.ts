import { join } from "node:path";
import { BRAND } from "@repo/contracts";

// The runner's background service: what gets written where, for each OS (docs/features/remote-machines.md#the-service).
// Pure, so tests can check the files without installing anything.

/** The systemd user unit's name. */
export const SYSTEMD_UNIT = `${BRAND.id}-runner.service`;
/** The launchd agent's label, which is also its plist's name. */
export const LAUNCHD_LABEL = `${BRAND.id}.runner`;

export interface ServiceSpec {
  /** The command the service runs, `--runner` included. */
  command: string[];
  /** Variables the service starts with: PATH, so the runner finds `git`, `gh` and the agent CLIs, and our own. */
  environment: Record<string, string>;
  /** Where launchd writes the runner's output; systemd sends it to the journal. */
  logFile: string;
}

export interface ServiceFile {
  path: string;
  contents: string;
}

/**
 * Quotes one word for a systemd `ExecStart=` or `Environment=` line; `%` would otherwise start a specifier. In
 * `ExecStart=` systemd also expands `$VAR`, even in quotes, so there `$` is doubled too.
 */
function systemdQuote(value: string, execStart = false): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${execStart ? escaped.replaceAll("$", "$$$$") : escaped}"`;
}

export function systemdUnit(spec: ServiceSpec, configHome: string): ServiceFile {
  const environment = Object.entries(spec.environment).map(
    ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
  );
  const contents = [
    "[Unit]",
    `Description=${BRAND.name} runner`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.command.map((word) => systemdQuote(word, true)).join(" ")}`,
    ...environment,
    // A crash restarts it; `service uninstall` (systemctl stop) doesn't.
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return { path: join(configHome, "systemd", "user", SYSTEMD_UNIT), contents };
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function launchdPlist(spec: ServiceSpec, userHome: string): ServiceFile {
  const strings = (values: string[]) => values.map((value) => `    <string>${xml(value)}</string>`);
  const environment = Object.entries(spec.environment).flatMap(([key, value]) => [
    `    <key>${xml(key)}</key>`,
    `    <string>${xml(value)}</string>`,
  ]);
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(LAUNCHD_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...strings(spec.command),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // Restarted after a crash, not after a clean exit (`service uninstall` boots it out first anyway).
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(spec.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(spec.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return { path: join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), contents };
}
