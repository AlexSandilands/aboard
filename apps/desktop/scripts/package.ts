/**
 * Packages the desktop app with electron-builder (a Windows NSIS installer for now) into `release/`.
 * Config lives here rather than in a static file so the product name and id come from BRAND. Expects
 * the web build, server bundle and main bundle to exist: run via `pnpm desktop:package`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAND } from "@repo/contracts";
import { Platform, build } from "electron-builder";

const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = ["dist/main.mjs", "dist/icons/icon.png", "../server/dist/server.mjs", "../web/dist/index.html"];
const missing = inputs.filter((path) => !existsSync(root + path));
if (missing.length > 0) throw new Error(`Missing build output: ${missing.join(", ")}. Run \`pnpm desktop:build\`.`);

await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget("nsis"),
  publish: "never",
  config: {
    appId: `com.${BRAND.id}.desktop`,
    productName: BRAND.name,
    executableName: BRAND.id,
    // Matches the app's own package.json name/version at runtime instead of `@repo/desktop`.
    extraMetadata: { name: BRAND.id, version: BRAND.version, description: `${BRAND.name} desktop app` },
    directories: { output: "release" },
    // Main is fully bundled and the server runs from resources, so the asar needs no node_modules.
    files: ["dist/**", "package.json", "!node_modules/**"],
    extraResources: [
      { from: "../server/dist", to: "server" },
      { from: "../web/dist", to: "web" },
    ],
    win: { icon: "dist/icons/icon.png" },
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
