import { BRAND, BRAND_REPOSITORY, brandEnv } from "./brand.ts";
import { DEFAULT_RUNNER_PORT } from "./desktop.ts";

// The headless server's release files and the script that installs a runner from them
// (docs/features/remote-machines.md#installing-a-runner). Shared by the release build, which publishes the script,
// the board, which pipes it over SSH, and the runner, which downloads its own updates.

export const SERVER_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;
export type ServerPlatform = (typeof SERVER_PLATFORMS)[number];

export const isServerPlatform = (value: string): value is ServerPlatform =>
  (SERVER_PLATFORMS as readonly string[]).includes(value);

/** The launcher's name, which is also the command users type: `<id>-server`. */
export const SERVER_LAUNCHER_NAME = `${BRAND.id}-server`;

/** The folder a tarball unpacks to, versioned so two releases can sit side by side. */
export const serverReleaseName = (version: string, platform: ServerPlatform): string =>
  `${SERVER_LAUNCHER_NAME}-${version}-${platform}`;

export const SERVER_CHECKSUMS = "SHA256SUMS-server.txt";
export const RUNNER_INSTALL_SCRIPT = "install-runner.sh";

/** Where a version's release files are downloaded from; null when the product isn't published on GitHub. */
export function serverReleaseBaseUrl(version: string): string | null {
  if (!BRAND_REPOSITORY) return null;
  return `https://github.com/${BRAND_REPOSITORY.owner}/${BRAND_REPOSITORY.repo}/releases/download/v${version}`;
}

/** The release platform of a machine, from Node's `process.platform` and `process.arch`; null when there is none. */
export function serverPlatformOf(platform: string, arch: string): ServerPlatform | null {
  const name = `${platform}-${arch}`;
  return isServerPlatform(name) ? name : null;
}

/** The first line the install script prints for the board, then a JSON object: the pairing code and where the runner is. */
export const RUNNER_INSTALL_RESULT_PREFIX = "@@pair ";
/** `@@step <key>`: the install script saying which step it starts, for the board's progress list. */
export const RUNNER_INSTALL_STEP_PREFIX = "@@step ";

/**
 * The one-line command that installs a runner by hand on a machine and prints a pairing code. `tailscale` makes the
 * runner reachable at its Tailscale address, for a machine the board can't SSH to.
 */
export function runnerInstallCommand(
  version: string,
  options: { tailscale?: boolean; /** The release files somewhere other than GitHub. */ baseUrl?: string | null } = {},
): string {
  // One word to the shell, whatever the URL holds; a plain one stays as it is, so the usual command reads cleanly.
  const word = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
  const base = options.baseUrl || serverReleaseBaseUrl(version) || "<release URL>";
  // The script must be told too, or it would download the tarball from GitHub.
  const args = [
    ...(options.baseUrl ? ["--base-url", word(options.baseUrl)] : []),
    ...(options.tailscale ? ["--tailscale"] : []),
  ];
  const script = word(`${base}/${RUNNER_INSTALL_SCRIPT}`);
  return `curl -fsSL ${script} | sh${args.length > 0 ? ` -s -- ${args.join(" ")}` : ""}`;
}

/**
 * `install-runner.sh` for `version`: downloads that release's tarball for the machine it runs on, checks it against
 * the release's checksums, unpacks it under `~/.local/share/<id>-server/releases/`, points `current` and
 * `~/.local/bin/<id>-server` at it, installs the background service and prints a pairing code.
 *
 * POSIX sh, and safe to pipe into `sh`: nothing in it reads stdin. Running it again installs over what is there, so
 * it is also how a runner is updated by hand.
 */
export function runnerInstallScript(version: string): string {
  const launcher = SERVER_LAUNCHER_NAME;
  return `#!/bin/sh
# Installs the ${BRAND.name} runner on this machine and prints a code to pair it with a board.
#   --version <v>     the release to install (default ${version})
#   --base-url <url>  where the release files are, instead of GitHub
#   --tailscale       let a board reach the runner at this machine's Tailscale address, not only through SSH
#   --port <n>        the port the runner listens on
#   --porcelain       also print lines a board reads (the SSH install uses it)
set -eu

version="${version}"
base_url=""
bind=""
port=""
porcelain=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --base-url) base_url="$2"; shift 2 ;;
    --tailscale) bind=private; shift ;;
    --port) port="$2"; shift 2 ;;
    --porcelain) porcelain=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$base_url" ] || base_url="${serverReleaseBaseUrl("$version") ?? ""}"

fail() {
  echo "$1" >&2
  exit 1
}
step() {
  if [ "$porcelain" = 1 ]; then echo "${RUNNER_INSTALL_STEP_PREFIX}$1"; fi
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) fail "There is no ${BRAND.name} runner for $(uname -s) $(uname -m)." ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the runner."
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack the runner."

# A command run over SSH gets a bare PATH. The service keeps the PATH it is installed with, so take the one a login
# shell has: that is where claude, codex and gh are found.
login_path="$("\${SHELL:-/bin/sh}" -lic 'printf "\\n__PATH__%s\\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__PATH__//p' | tail -n 1)" || login_path=""
if [ -n "$login_path" ]; then PATH="$login_path"; fi
export PATH

name="${launcher}-$version-$platform"
root="\${XDG_DATA_HOME:-$HOME/.local/share}/${launcher}"
bin="$HOME/.local/bin"
mkdir -p "$root/releases" "$bin"

step download
if [ -x "$root/releases/$name/bin/${launcher}" ]; then
  echo "${BRAND.name} runner $version is already downloaded."
  step verify
else
  tmp="$(mktemp -d "$root/releases/.download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $base_url/$name.tar.gz"
  curl -fsSL -o "$tmp/$name.tar.gz" "$base_url/$name.tar.gz" </dev/null ||
    fail "Couldn't download $base_url/$name.tar.gz. Is there a release $version for $platform?"
  curl -fsSL -o "$tmp/sums" "$base_url/${SERVER_CHECKSUMS}" </dev/null ||
    fail "Couldn't download the checksums from $base_url/${SERVER_CHECKSUMS}."
  step verify
  expected="$(awk -v file="$name.tar.gz" '$2 == file { print $1 }' "$tmp/sums")"
  [ -n "$expected" ] || fail "The release's checksums don't list $name.tar.gz."
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$name.tar.gz" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{ print $1 }')"
  fi
  [ "$actual" = "$expected" ] || fail "The download doesn't match its checksum ($actual, not $expected); nothing was installed."
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$root/releases/$name"
  mv "$tmp/$name" "$root/releases/$name"
  rm -rf "$tmp"
  trap - EXIT
fi

# \`current\` is what the service runs through, so an update only has to point it at another release.
ln -sfn "releases/$name" "$root/current"
ln -sfn "$root/current/bin/${launcher}" "$bin/${launcher}"

step service
if [ -n "$bind" ]; then
  ${brandEnv("BIND")}="$bind"
  export ${brandEnv("BIND")}
fi
if [ -n "$port" ]; then
  ${brandEnv("PORT")}="$port"
  export ${brandEnv("PORT")}
fi
"$bin/${launcher}" service install </dev/null || fail "The runner is installed in $root, but its service didn't start."

step pair
tailscale_ip=""
if [ -n "$bind" ] && command -v tailscale >/dev/null 2>&1; then
  tailscale_ip="$(tailscale ip -4 2>/dev/null </dev/null | head -n 1)" || tailscale_ip=""
fi
if [ "$porcelain" = 1 ]; then
  printf '${RUNNER_INSTALL_RESULT_PREFIX}'
  "$bin/${launcher}" pair --json --tailscale-ip "$tailscale_ip" </dev/null
else
  "$bin/${launcher}" pair </dev/null
  if [ -z "$bind" ]; then
    echo "The runner listens on this machine only. To pair it by this code, a board must reach it: run this script"
    echo "again with --tailscale, or add the machine from the board over SSH instead."
  elif [ -n "$tailscale_ip" ]; then
    echo "In the board, add a machine by its pairing code, with the address http://$tailscale_ip:\${port:-${DEFAULT_RUNNER_PORT}} and that code."
  else
    echo "In the board, add a machine by its pairing code, with this machine's Tailscale address, port \${port:-${DEFAULT_RUNNER_PORT}}, and that code."
  fi
fi
`;
}
