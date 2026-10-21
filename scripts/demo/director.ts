/**
 * Records the README demo GIF from a fresh showcase sandbox: `pnpm demo:record`.
 *
 * It restarts this checkout's sandbox (`pnpm sandbox --seed showcase`), opens Chromium at 1600x960 with a device
 * scale of 2, and plays the beats below with a drawn cursor. What the GitHub poller and the Autopilot engine would
 * do goes through the sandbox's /api/demo routes; everything else is the real UI or plain REST. The take (frames
 * and timeline.json) stays in a temp folder, so encode.ts can re-encode it without recording again.
 *
 * It also retakes the task panel screenshot (`--panel`) from the same board before the take starts.
 *
 *   node scripts/demo/director.ts [--out .github/assets/demo.gif] [--panel .github/assets/task-panel.png]
 *     [--take <dir>] [--shots] [--keep-sandbox]
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { DEFAULT_ENCODE, encode, type Rect, type Timeline, type Zoom } from "./encode.ts";
import { click, endCard, glide, installOverlay, pointOf, showKeys } from "./overlay.ts";
import { startRecording, type Recording } from "./recorder.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  displayName: string;
  description: string;
};
const VIEWPORT = { width: 1600, height: 960, scale: 2 };
/** The app's default favicon, from index.html: the page's own icon link carries the unread badge. */
const DEFAULT_ICON = /<link rel="icon"[^>]*href="([^"]+)"/.exec(
  readFileSync(join(root, "apps/web/index.html"), "utf8"),
)![1]!;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag("out") ?? join(root, ".github/assets/demo.gif");
const panelOut = flag("panel") ?? join(root, ".github/assets/task-panel.png");
const takeDir = flag("take") ?? join(tmpdir(), "demo-take");
/** Saves a screenshot after each beat, for checking the beats without encoding. */
const shots = args.includes("--shots");
const keepSandbox = args.includes("--keep-sandbox");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sandbox {
  url: string;
  serverPort: number;
  home: string;
}

function pnpm(...argv: string[]) {
  return spawnSync("pnpm", ["-s", ...argv], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
}

/** A fresh showcase sandbox: a take changes the board, so it never reuses one. */
async function startSandbox(): Promise<Sandbox> {
  pnpm("sandbox", "stop");
  const logPath = join(takeDir, "sandbox.log");
  const log = openSync(logPath, "w");
  const child = spawn("pnpm", ["sandbox", "--seed", "showcase"], {
    cwd: root,
    stdio: ["ignore", log, log],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  closeSync(log);
  child.unref();
  for (let i = 0; i < 120; i++) {
    const ready = /^SANDBOX_READY (.*)$/m.exec(readFileSync(logPath, "utf8"));
    if (ready) return JSON.parse(ready[1]!) as Sandbox;
    await sleep(1000);
  }
  throw new Error(`the sandbox didn't start; see ${logPath}`);
}

function api(sandbox: Sandbox) {
  // Straight to the server: a request with no Origin passes the guard, and the sandbox has no token.
  const base = `http://127.0.0.1:${sandbox.serverPort}`;
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}

type Api = ReturnType<typeof api>;

interface TaskInfo {
  id: string;
  number: number;
  title: string;
}

/**
 * Start session must not open a real terminal or a real CLI: a custom terminal command of `true {command}` runs
 * nothing, and the Claude Code path points at a stub that only answers `--version`, so the CLI counts as installed
 * without touching the user's own (its model scan would run their hooks).
 */
async function stubAgentLaunch(call: Api, sandbox: Sandbox): Promise<void> {
  const stub = join(sandbox.home, "claude-stub");
  writeFileSync(stub, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
  chmodSync(stub, 0o755);
  await call("PATCH", "/api/settings", {
    terminal: { kind: "custom", template: "true {command}" },
    headlessReviewCli: stub,
  });
}

/** The board's tasks by title, and the ids the beats need. */
async function lookUp(call: Api) {
  const tasks = await call<TaskInfo[]>("GET", "/api/tasks");
  const task = (title: string) => {
    const found = tasks.find((t) => t.title === title);
    if (!found) throw new Error(`no task "${title}" in the showcase seed`);
    return found;
  };
  const blocker = task("Inline payment form");
  const freed = ["Save cards for next time", "Express checkout buttons", "Fraud checks on card payments"].map(task);
  const merging = task("Merge shipping and billing steps");
  const webhooks = task("Retry failed payment webhooks with backoff");
  const blockerDetail = await call<{ phases: { title: string; steps: { id: string; status: string }[] }[] }>(
    "GET",
    `/api/tasks/${blocker.id}`,
  );
  const openSteps = blockerDetail.phases.flatMap((p) => p.steps).filter((s) => s.status !== "done");
  // The finished phase the panel shows folded, which the cursor opens.
  const donePhase = blockerDetail.phases.find((p) => p.steps.every((s) => s.status === "done"))!.title;
  const mergingDetail = await call<{ links: { id: string; kind: string }[] }>("GET", `/api/tasks/${merging.id}`);
  const prLink = mergingDetail.links.find((l) => l.kind === "pr")!;
  return { blocker, freed, merging, webhooks, openSteps, donePhase, prLinkId: prLink.id };
}

const card = (page: Page, task: TaskInfo) => page.locator(`[data-task-card="${task.id}"]`).first();

async function rectOf(...targets: Locator[]): Promise<Rect> {
  const boxes = await Promise.all(targets.map((t) => t.boundingBox()));
  const valid = boxes.filter((b): b is NonNullable<typeof b> => !!b);
  const x = Math.min(...valid.map((b) => b.x));
  const y = Math.min(...valid.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...valid.map((b) => b.x + b.width)) - x,
    height: Math.max(...valid.map((b) => b.y + b.height)) - y,
  };
}

/** Drags with the real pointer while the drawn cursor follows, eased, so dnd-kit sees a real drag. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ms = 900) {
  await glide(page, from);
  await page.mouse.down();
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e;
    await page.evaluate((at) => window.demoOverlay.move(at.x, at.y, 0), { x, y });
    await page.mouse.move(x, y);
    await sleep(8);
  }
  await page.mouse.up();
}

/** Wheels the element under the pointer until `target` sits `top` pixels from the top, in small eased steps. */
async function scrollTo(page: Page, target: Locator, top: number) {
  const box = await target.boundingBox();
  if (!box) return;
  const distance = box.y - top;
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    // Bell-shaped step sizes, so the scroll eases in and out.
    await page.mouse.wheel(0, (distance * Math.PI * Math.sin(Math.PI * p)) / (2 * steps));
    await sleep(22);
  }
}

/** Types like a quick typist: steady, with a little jitter, so it doesn't look pasted. */
async function typeQuickly(page: Page, text: string) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(28 + Math.random() * 22);
  }
}

async function record(sandbox: Sandbox): Promise<Timeline> {
  const call = api(sandbox);
  await stubAgentLaunch(call, sandbox);
  const ids = await lookUp(call);

  // Full Chromium in its new headless mode, with the scale forced: otherwise the screencast sends frames at CSS
  // pixels whatever the context's device scale.
  const browser = await chromium.launch({
    channel: "chromium",
    args: [`--force-device-scale-factor=${VIEWPORT.scale}`],
  });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: VIEWPORT.scale,
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await installOverlay(page);
  // The task panel screenshot first, while the board is as seeded: the PR task, with its failing checks and findings.
  await page.goto(new URL(`?task=${ids.webhooks.id}`, sandbox.url).href);
  await page.getByRole("heading", { name: ids.webhooks.title }).waitFor();
  await sleep(1200);
  await page.screenshot({ path: panelOut, scale: "css" });
  await page.goto(sandbox.url);
  await card(page, ids.blocker).waitFor();
  // Fonts, icons and the first SSE snapshot settle before the first frame.
  await sleep(1500);
  await page.evaluate(() => window.demoOverlay.move(1480, 880, 0));

  const framesDir = join(takeDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const rec: Recording = await startRecording(page, framesDir, {
    width: VIEWPORT.width * VIEWPORT.scale,
    height: VIEWPORT.height * VIEWPORT.scale,
  });
  const zooms: Zoom[] = [];
  const zoomTo = (rect: Rect | null, ms = 900) => zooms.push({ at: rec.now(), ms, rect });
  let shot = 0;
  const snap = async (name: string) => {
    if (shots) await page.screenshot({ path: join(takeDir, `shot-${++shot}-${name}.png`) });
  };

  // Beat 1: the task panel. Click the epic's In Progress task; the panel slides in, scrolls to the plan, opens the
  // finished phase, and the current phase's last two steps tick off live.
  const band = page.locator("header[data-task-card]").first().locator("..");
  await sleep(400);
  zoomTo(await rectOf(band), 800);
  await click(page, card(page, ids.blocker), 700, 0.45, 0.35);
  const panelTitle = page.getByRole("heading", { name: ids.blocker.title });
  await panelTitle.waitFor();
  zoomTo(null, 600);
  await sleep(700);
  const planHeader = page.getByRole("button", { name: /^Plan/ }).last();
  const phase = page.getByRole("button", { name: new RegExp(`^\\d+\\s*${ids.donePhase}`) }).last();
  await glide(page, await pointOf(panelTitle, 0.5, 6), 400);
  await scrollTo(page, planHeader, 120);
  await sleep(200);
  const panelBox = (await panelTitle.boundingBox())!;
  const planTop = (await planHeader.boundingBox())!.y;
  zoomTo({ x: panelBox.x - 16, y: planTop - 16, width: 1600 - panelBox.x + 16, height: 300 }, 700);
  await click(page, phase, 450, 0.3, 0.5);
  await sleep(700);
  const [third, fourth] = ids.openSteps;
  await call("PATCH", `/api/steps/${third!.id}`, { status: "done" });
  await sleep(250);
  await call("PATCH", `/api/steps/${fourth!.id}`, { status: "in_progress" });
  await sleep(800);
  await call("PATCH", `/api/steps/${fourth!.id}`, { status: "done" });
  await sleep(900);
  await snap("panel");
  await showKeys(page, "Esc");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Beat 2: dependencies. Back out to the epic and onto the task: green lines fan out to the three tasks it frees,
  // red to the one it waited on; Shift draws the chain beyond them.
  zoomTo(await rectOf(band), 800);
  await glide(page, await pointOf(card(page, ids.blocker), 0.45, 0.4), 500);
  await sleep(1300);
  await snap("lines");
  await showKeys(page, "Shift");
  await page.keyboard.down("Shift");
  await sleep(1400);
  await snap("chain");
  await page.keyboard.up("Shift");
  await sleep(200);

  // Beat 3: the chain moves. The task is dragged to Done, the locks drop off all three, and Autopilot starts each,
  // sliding them into In Progress.
  const doneColumn = await pointOf(page.locator("header[data-task-card]").first(), 0.92, 4);
  await drag(page, await pointOf(card(page, ids.blocker), 0.45, 0.4), doneColumn, 800);
  await sleep(800);
  await snap("dragged");
  await glide(page, await pointOf(card(page, ids.freed[1]!), 1.05, 0.5), 450);
  const runs: { id: string }[] = [];
  for (const task of ids.freed) {
    runs.push(
      await call<{ id: string }>("POST", "/api/demo/autopilot/runs", {
        automation: "start_planned",
        taskId: task.id,
        summary: `start ${task.title}`,
      }),
    );
    await sleep(180);
  }
  await sleep(700);
  for (const task of ids.freed) {
    await call("POST", `/api/tasks/${task.id}/move`, { status: "in_progress" });
    await sleep(300);
  }
  await sleep(700);
  await snap("autopilot");
  for (const run of runs) {
    await call("POST", `/api/demo/autopilot/runs/${run.id}/finish`, { summary: "Started a Claude Code session" });
  }

  // Beat 4: a failing PR. Push in on the card; Autopilot's fix run takes the checks from red to amber to green.
  const prCard = card(page, ids.merging);
  zoomTo(await rectOf(prCard), 900);
  await glide(page, await pointOf(prCard.getByText("#91"), 0.5, 0.5), 600);
  await sleep(600);
  const fix = await call<{ id: string }>("POST", "/api/demo/autopilot/runs", {
    automation: "fix_prs",
    taskId: ids.merging.id,
    summary: "fix the failing checks on PR #91",
  });
  await sleep(1000);
  await call("POST", `/api/demo/links/${ids.prLinkId}/pr`, { checks: "pending" });
  await sleep(1100);
  await call("POST", `/api/demo/links/${ids.prLinkId}/pr`, { checks: "passing" });
  await call("POST", `/api/demo/autopilot/runs/${fix.id}/finish`, { summary: "Pushed a fix; checks pass" });
  await sleep(1000);
  await snap("pr");

  // Beat 5: a new task and a session. N, the project, a title, Enter; then the hand-off menu starts a Claude Code session.
  // The palette and the dialog are pushed in on, so their text reads at the README's width.
  zoomTo(null, 600);
  await sleep(400);
  await showKeys(page, "N");
  await page.keyboard.press("n");
  const palette = page.getByRole("dialog").last();
  await palette.waitFor();
  zoomTo(await rectOf(palette), 600);
  await sleep(300);
  // With no project in focus, N asks for the project first.
  await typeQuickly(page, "store");
  await sleep(150);
  await page.keyboard.press("Enter");
  await sleep(250);
  await typeQuickly(page, "Apple Pay at checkout");
  await sleep(200);
  await showKeys(page, "Enter");
  await page.keyboard.press("Enter");
  zoomTo(null, 600);
  await sleep(700);
  await snap("created");
  const created = page.locator('[data-task-card][aria-label$="Apple Pay at checkout"]').first();
  await click(page, created.getByRole("button", { name: "Hand off to an agent" }), 450);
  await sleep(350);
  await click(page, page.getByRole("menuitem", { name: /New Claude Code session/ }), 320);
  const message = page.getByRole("textbox", { name: "First message" });
  await message.waitFor();
  zoomTo(await rectOf(page.getByRole("dialog").last()), 600);
  await sleep(400);
  await click(page, message, 350, 0.3, 0.3);
  await page.keyboard.press("Control+A");
  await typeQuickly(page, "Add Apple Pay to the inline payment form.");
  await sleep(200);
  await click(page, page.getByRole("combobox", { name: "Where to run" }), 380);
  await sleep(250);
  await click(page, page.getByRole("option", { name: "This checkout" }), 300);
  await sleep(300);
  await snap("dialog");
  await click(page, page.getByRole("button", { name: "Start session" }), 380);
  await sleep(300);
  zoomTo(await rectOf(created), 700);
  await sleep(1500);
  await snap("session");

  // Beat 6: back to the whole board, then the end card over it.
  zoomTo(null, 800);
  await sleep(1000);
  await endCard(page, {
    name: pkg.displayName,
    tagline: pkg.description.split(":")[0]!,
    detail: "A local kanban board your agents update over MCP",
    // The page's icon link carries the unread badge by now; the end card wants the plain mark.
    icon: new URL(DEFAULT_ICON, sandbox.url).href,
  });
  await sleep(1600);
  const { duration } = await rec.stop();
  await snap("end");
  await browser.close();
  return { viewport: VIEWPORT, start: 0, end: duration, zooms };
}

// Only what a take writes is cleared, so a mistaken --take never wipes a folder of other files.
for (const entry of ["frames", "cfr", "png"]) rmSync(join(takeDir, entry), { recursive: true, force: true });
mkdirSync(takeDir, { recursive: true });
const sandbox = await startSandbox();
console.log(`[demo] sandbox at ${sandbox.url}; recording into ${takeDir}`);
try {
  const timeline = await record(sandbox);
  writeFileSync(join(takeDir, "timeline.json"), JSON.stringify(timeline, null, 2));
  encode(takeDir, { ...DEFAULT_ENCODE, out });
} finally {
  if (!keepSandbox) pnpm("sandbox", "stop");
}
