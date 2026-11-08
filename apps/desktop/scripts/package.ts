/**
 * Packages the desktop app with electron-builder into `release/`, for the platform it runs on: the NSIS installer on
 * Windows; AppImage, .deb, .rpm and a tarball on Linux (the Arch packages repackage the tarball). Config lives here
 * rather than in a static file so the product name and id come from BRAND. Expects the web build, server bundle and
 * main bundle to exist: run via `pnpm desktop:package`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../../../package.json" with { type: "json" };
import { BRAND, BRAND_REPOSITORY, brandEnv } from "@repo/contracts";
import { Arch, Platform, build } from "electron-builder";

const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = ["dist/main.mjs", "dist/icons/icon.png", "../server/dist/server.mjs", "../web/dist/index.html"];
const missing = inputs.filter((path) => !existsSync(root + path));
if (missing.length > 0) throw new Error(`Missing build output: ${missing.join(", ")}. Run \`pnpm desktop:build\`.`);

/**
 * What each host builds, unless the command line names targets (`pnpm desktop:package tar.gz`). The .rpm needs
 * rpmbuild installed: the `rpm` package on Debian and Ubuntu.
 */
const TARGETS: Partial<Record<NodeJS.Platform, { platform: Platform; targets: string[] }>> = {
  win32: { platform: Platform.WINDOWS, targets: ["nsis"] },
  linux: { platform: Platform.LINUX, targets: ["AppImage", "deb", "rpm", "tar.gz"] },
};
const host = TARGETS[process.platform];
if (!host) throw new Error(`No package targets for ${process.platform}.`);
const requested = process.argv.slice(2);
if (!BRAND_REPOSITORY)
  throw new Error("The root package.json `repository` must be a GitHub URL: the updater reads releases from it.");
/**
 * For trying updates locally only: a build that reads its feed from this URL (a folder you serve with a newer build's
 * files and `latest*.yml`) instead of GitHub. Release builds never set it.
 */
const testFeed = process.env[brandEnv("UPDATE_FEED_URL")];

await build({
  projectDir: root,
  targets: host.platform.createTarget(requested.length > 0 ? requested : host.targets, Arch.x64),
  publish: "never",
  config: {
    // Where the packaged app looks for updates: electron-builder writes `app-update.yml` into resources and the
    // `latest*.yml` feed and blockmaps beside the installers. It never uploads (`publish: "never"` above); CI
    // does. The repo is spelled out because electron-builder can't work it out from a tag checkout, and a GH_TOKEN in
    // the environment then made it crash after building (a3644be9).
    publish: testFeed
      ? { provider: "generic", url: testFeed }
      : { provider: "github", owner: BRAND_REPOSITORY.owner, repo: BRAND_REPOSITORY.repo, releaseType: "release" },
    appId: `com.${BRAND.id}.desktop`,
    productName: BRAND.name,
    executableName: BRAND.id,
    // Matches the app's own package.json name/version at runtime instead of `@repo/desktop`.
    extraMetadata: {
      name: BRAND.id,
      version: BRAND.version,
      description: pkg.description,
      author: pkg.author,
      homepage: pkg.homepage,
      license: pkg.license,
      desktopName: `${BRAND.id}.desktop`,
    },
    directories: { output: "release" },
    // Main is fully bundled and the server runs from resources, so the asar needs no node_modules.
    files: ["dist/**", "package.json", "!node_modules/**"],
    // Beside the executable, so every install carries the license and the third-party notices.
    extraFiles: [
      { from: "../../LICENSE", to: "LICENSE" },
      { from: "../../NOTICE", to: "NOTICE" },
    ],
    extraResources: [
      { from: "../server/dist", to: "server" },
      { from: "../web/dist", to: "web" },
    ],
    win: { icon: "dist/icons/icon.png" },
    linux: {
      icon: "dist/icons/icon.png",
      category: "Development",
      // electron-builder reads these from the desktop workspace's package.json, before extraMetadata applies.
      maintainer: pkg.author,
      vendor: pkg.author,
      synopsis: "Mission control for your coding agents",
      // Electron gives windows this as their Wayland app id and X11 class, so docks match them to the menu entry.
      syncDesktopName: true,
      // The tarball's name; the other Linux targets set their own below.
      artifactName: `${BRAND.id}-\${version}-linux-\${arch}.\${ext}`,
    },
    appImage: { artifactName: `${BRAND.name}-\${version}-\${arch}.\${ext}` },
    deb: { artifactName: `${BRAND.id}_\${version}_\${arch}.\${ext}` },
    rpm: { artifactName: `${BRAND.id}-\${version}.\${arch}.\${ext}` },
    npmRebuild: false,
    electronFuses: {
      // T3 Code and VS Code terminals export ELECTRON_RUN_AS_NODE; it must not turn the app into Node.
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableCookieEncryption: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    nsis: {
      artifactName: `${BRAND.name}-Setup-\${version}.\${ext}`,
      oneClick: true,
      perMachine: false,
    },
  },
});
