# Rewriting the board in Rust with a GPUI front end

**A dated assessment, not a plan.** Written 2026-11-06 for task #85. It asks whether the whole board could
be rewritten in Rust: a Rust server (REST, SSE, MCP, SQLite, Autopilot, the pollers, backups) and a native
[GPUI](https://www.gpui.rs/) window replacing both the React app and the Electron shell. Nothing here is
built. GPUI is pre-1.0 and changes weekly, so check the sources before acting on any claim about it.

## Verdict

**Feasible, and worth doing in two halves on different timelines.**

- **The Rust server: go, whenever we want it.**
  - Every part has a mature crate (axum, rusqlite, rmcp, tokio). The same SQLite file and migrations carry over,
    and our tests specify the behaviour.
  - It can ship behind today's React app and Electron shell with no visible change. That alone takes the
    always-on part from ~96 MB to tens of MB and takes Node out of the runtime.
  - About 3.5–6 person-months.
- **The GPUI window: not yet.**
  - It is buildable, and it would look nearly the same: same layout, type, colours and themes, and probably
    smoother motion.
  - It would cut install size about tenfold (290 MiB to tens of MB) and memory severalfold.
  - Four things hold it back today:
    1. GPUI has no current official release, only weekly snapshots that break.
    2. There is no rich Markdown editor to replace TipTap.
    3. Machines without a working GPU are an unmeasured risk.
    4. We would lose the board in a browser and our web tooling.
  - It also costs most of the effort: roughly 8–15 person-months.
  - Revisit when the conditions under [What would change the answer](#what-would-change-the-answer) move, and
    start with the measurement spike described there.
- **Visible losses:** frosted glass (popovers become flat translucent surfaces), the WYSIWYG editor unless we
  build one, agents' HTML art without a webview, and the board in a browser unless the web UI stays alongside.

A full rewrite, done server first, is about 11–21 person-months to reach today's features.

## What a rewrite has to cover

Sizes are non-test lines, 2026-11-06.

| Part                  | Size                  | What's in it                                                                                     |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/server`         | ~37.5k lines TS       | ~141 REST handlers, SSE, 37 MCP tools, 40 migrations over 27 tables, Autopilot, pollers, backups |
| `apps/web`            | ~62k TS/TSX, 1.7k CSS | The board, task panel, settings (13k alone), themes, the rich editor, stats, social              |
| `apps/desktop`        | ~1.1k                 | Tray, start at login, attach-or-spawn, title bar, badges, the art frames' sandbox                |
| `packages/contracts`  | ~9.7k                 | ~231 zod schemas, the prompts and embedded skill text agents read, keybindings                   |
| Tests                 | 236 files             | 112 server, 96 web, 26 contracts, 2 desktop                                                      |

### How hard each part is to port

**Has a direct Rust equivalent** (a port, not a redesign):

| Today                                                          | In Rust                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Hono routes, the localhost guard, static files                 | `axum` 0.8 with a guard layer                                                                  |
| SSE bus (11 event types, no replay)                            | `axum::response::sse` over a `tokio::sync::broadcast` channel                                   |
| `node:sqlite`, WAL, `BEGIN IMMEDIATE`, the 40 migrations       | `rusqlite` with `bundled` SQLite on the same database file; the 38 `.sql` migrations run as they are, the two code migrations (008, 036) are ported |
| Services, repos, Autopilot rules, digest, stats, review rounds | Plain Rust. Most of the work by volume, but no unknowns                                         |
| zod schemas in contracts                                       | `serde` types with validation; one crate shared by server and UI, as contracts is now           |
| `child_process` for git, gh, claude, codex, copilot, scripts   | `tokio::process`; process-tree kill with `taskkill /T` / process groups as now                 |
| fetch (GitHub GraphQL), WebSocket (T3 RPC)                     | `reqwest`, `tokio-tungstenite`                                                                 |
| The MCP SDK, stateless streamable HTTP                         | `rmcp` 3.9 (official), `StreamableHttpService` nested at `/mcp`                                 |
| Theme maths (culori, OKLCH, contrast solving), VS Code import  | Pure functions; port `derive.ts` and `color.ts` directly, `zip` crate for Open VSX              |
| Electron tray, login items, single instance                    | `tray-icon` or `ksni`, `auto-launch`, a probe of our own port                                  |

**Needs custom work** (GPUI gives the parts, we build the feature):

- **Board drag and drop.** GPUI has `on_drag` with a preview view, `on_drop`, `drag_over` and `on_drag_move`, but
  nothing sortable. The placeholder gap, collision rules (the pure part of `dnd.logic.ts` ports), keyboard
  dragging and the drop animation are ours to write. The same goes for sortable plan steps, panel sections and
  the sidebar's projects.
- **Motion.** Card FLIP, panel and sidebar slides, the ten keyframe animations: GPUI has `with_animation` and
  easing functions, not CSS transitions or layout animation.
- **Dependency lines.** A path drawn in a `canvas` from card bounds after layout.
- **Markdown rendering.** GPUI Kit's `TextView` renders GFM with tables; `#N` task refs and attachment URLs need
  hooks.
- **The script editor.** GPUI Kit's `Editor` (tree-sitter) can replace CodeMirror; PowerShell needs its grammar
  added.
- **Theming every surface.** 61 roles and about 454 CSS variables become a theme struct read by every component.
- **The terminal launcher's Windows quoting.** A faithful port of `terminal.ts`, which only its tests specify.

**Has no good answer yet:**

- **The rich Markdown editor.** Nothing in the GPUI world matches TipTap/ProseMirror with a byte-exact Markdown
  round trip. See [The rich editor](#the-rich-editor).
- **Glass.** GPUI can't blur what's behind an element. See [Look and feel](#look-and-feel).
- **The social art sandbox.** It runs agents' HTML and JavaScript in a sandboxed iframe. GPUI can't render HTML,
  so this needs a webview (GPUI Kit has an experimental `wry` one), which brings WebKitGTK back on Linux.

### What would be lost

- **The board in a browser.** Today `http://127.0.0.1:4317` opens it in any browser: the T3 preview pane, a
  second machine through an SSH tunnel, a phone on the LAN through a proxy, or `pnpm sandbox --live`. A GPUI-only
  board is only on the machine with the window. GPUI has an experimental web target (`gpui_web` in Zed's tree) but
  nothing to rely on.
- **Our web tooling.** Vite hot reload, the sandbox's browser previews, `pnpm demo:record`, and agents checking
  UI changes in a browser. GPUI rebuilds take seconds to minutes, and GPUI has headless test contexts but no
  equivalent of opening a page and looking.
- **Agents' fluency.** Agents write React well. GPUI has far less code to learn from and breaks its API every few
  weeks, so expect agent-written UI code to need more correction.

**Not lost:** the board stays reachable with its window closed. The server lives in the same process and keeps
running in the tray, as it does today (below).

## One binary: server, window and tray

- **One process, two halves.** A tokio runtime on worker threads runs the server (axum, rmcp, pollers,
  Autopilot). GPUI owns the main thread. `set_quit_mode(QuitMode::Explicit)` keeps the app alive with no window
  open (`crates/gpui/src/app.rs` on Zed's main branch, 2026-11; not confirmed in the published crates). Closing
  the window drops its GPU resources, leaving only the server and the tray.
- **The UI talks HTTP and SSE to the server, even in the same process.** It costs little (the full task list,
  607 KB of JSON for 625 tasks, takes 12 ms today) and keeps one code path for the cases that need it: attaching
  to a server that's already running (a `serve` instance, the sandbox), several windows, and the browser if the web
  UI is kept. Calling services directly is an optimisation for later.
- **A headless mode.** A `serve` subcommand runs the server with no window. This replaces `pnpm start` and `pnpm sandbox` without `--desktop`. It's also the answer for machines
  with no usable GPU, since wgpu loads Vulkan or GL only when a window opens.
- **Tray.** Neither GPUI nor GPUI Kit has one. On Linux, `ksni` speaks StatusNotifierItem over D-Bus on its own
  thread with no GTK, which is what KDE and GNOME's AppIndicator extension show; Electron's tray already depends
  on that extension. On Windows, `tray-icon` needs a message loop on the thread that created it, which has to
  share GPUI's. No published GPUI app shows this working; it's a risk to try early.
- **Single instance and attach.** The health probe stays: if our server already answers on the port, a new
  launch opens a window on it (or asks the running instance to show its window over a local socket), and fails if
  something else holds the port.

## Performance

### Today, measured

On Linux (Wayland, x86_64) on 2026-11-06. The app figures are the installed desktop app 2026.11.3, running for
42 minutes on a real board, read from `/proc/<pid>/smaps_rollup`. The server figures are its bundled
`server.mjs` on Node 26, on a throwaway data dir with the pollers off. PSS splits shared pages between the
processes that share them, so it's the fairer total.

| What                                     | Measured                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Installed size                           | 290 MiB, of which our code is ~13.5 MB (server 2.9, web 9.6, shell 1); the rest is Electron       |
| Memory, whole app                        | 9 processes, **~565 MB PSS** (1.16 GB RSS)                                                       |
| …by process (PSS)                        | renderer 154, GPU 149, main 94, server 96, network 27, zygotes and broker 44 MB                  |
| Server cold start                        | ~120 ms to a healthy `/api/health` on an empty database                                          |
| Server memory                            | 67 MB PSS idle; 168 MB PSS after creating 625 tasks with plans                                    |
| `GET /api/tasks`, 625 tasks (607 KB)     | 12 ms                                                                                            |
| Window start and frame times             | Not measured: it needs a visible window                                                          |

From [appearance.md](../features/appearance.md): sliding the panel or sidebar lays the board out every frame
and tops out at 150 to 180 frames a second on a 280 Hz screen. Much of the web app's motion code (snapshot
motion, View Transitions, PNG grain, the opaque scroller) works around how Chromium paints and composites.

### Published figures

- **Zed/GPUI** publishes no startup or memory benchmarks. The "120 fps" goal is a design target, not a
  measurement ([zed.dev/blog/videogame](https://zed.dev/blog/videogame), 2023-03-07). Third-party Zed vs VS Code
  comparisons contradict each other by about ten times, so they aren't used here.
- **wgpu on Linux:** a reviewer on the PR that moved Linux to wgpu measured an empty window at about 100 MB, versus
  about 10 MB with GPUI's native Windows renderer, and similar once content was drawn
  ([zed#46758](https://github.com/zed-industries/zed/pull/46758), ~2026-02).
- **Download sizes, 2026-11-04 releases:** Electron 45's runtime zip is 118 MiB on Linux and 150 MiB on Windows.
  Zed 1.27, a whole IDE on GPUI, is 86 MiB (Linux tarball) and 61 MiB (Windows installer). GPUI Kit's hello world
  is about 12 MB ([gpui-kit.com/docs/comparison](https://gpui-kit.com/docs/comparison), v0.9.0).
- **Electron vs Tauri** as a reference for "native shell" savings (macOS): Electron 323 MB, 273 ms start, 128 MB
  idle; Tauri 57 MB, 311 ms, 109 MB
  ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/),
  2026-07-20). For a small app, startup barely differs. The gain is size, plus memory once real UI is open.
- **Server side:** no benchmark matches our load. axum and rusqlite add little over SQLite itself. A Rust server
  holds data as structs rather than a JavaScript heap, and has no V8 heap that grows and only slowly shrinks.

### What to expect

These are estimates from the figures above, not measurements. Each range is wide on purpose.

| Metric                            | Today            | Rust + GPUI (estimate)  | Why                                                                                     |
| --------------------------------- | ---------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Installed size                    | 290 MiB          | 25–60 MB                | No Chromium or Node. Zed, a much larger app, is 86 MiB                                  |
| Memory, window open               | ~565 MB PSS      | 120–250 MB              | One process. wgpu's ~100 MB window floor and the font and glyph atlases are most of it    |
| Memory, window closed (tray)      | ~565 MB PSS      | 15–50 MB                | The window's GPU resources go. Today the hidden renderer and GPU process stay            |
| Server cold start                 | ~120 ms          | 10–40 ms                | No JS to load. Migrations and SQLite open dominate                                       |
| Window to first paint             | not measured     | 100–300 ms              | No renderer process or JS bundle; theme and data load as today                          |
| Panel and sidebar slides          | 150–180 fps cap  | display refresh, likely | GPUI lays out every frame anyway. Unproven on a full board                               |
| API latency, SQLite queries       | ~12 ms full list | about the same          | Already bounded by SQLite and JSON size                                                  |

**The biggest win is the always-on footprint.** The board runs all day in the tray so agents can reach MCP. That
costs about 565 MB today and would cost tens of MB.

**Where Rust won't help:**

- What Autopilot spends its time on: `claude -p`, `codex exec`, `gh` and `git` runs take seconds to minutes each.
- GitHub polling, which waits on the network.
- How fast agents work.
- Request latency, which is already a few milliseconds.

**What we'd get for free:** the Chromium workarounds in `lib/boardMotion.ts`, `lib/slide.ts` and the grain tiles
would have nothing to work around. In their place there'd be GPUI's own limits.

## Look and feel

The board's look is T3 Code's tokens and themes ([reference/style.md](../reference/style.md),
[appearance.md](../features/appearance.md)). GPUI draws with `div`-like elements and flexbox (via `taffy`),
rounded corners, borders, box shadows, linear gradients, images, SVG and text, with sizes in `px` or `rems`. So
a card, a column and the panel can be laid out the way they are now. What changes is how effects and motion are
made.

### Feature by feature

| Today                                                                    | In GPUI                                                                                                                                         | Result                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Themes: 5 built-ins, 61 roles, light/dark halves, custom themes          | A theme struct built from the same data; the palette maths (`derive.ts`, `color.ts`) ported. GPUI colours are `Hsla`, so convert from OKLCH once | Identical                 |
| VS Code and Open VSX theme import, the theme editor and Inspect          | Import is pure parsing (`serde_json`, `zip`). The editor needs GPUI Kit's `ColorPicker`. Inspect works by probing CSS variables, so it needs another approach | Identical, Inspect redone |
| Contrast 50–200 %                                                        | Computed into the theme instead of CSS `color-mix`                                                                                              | Identical                 |
| Interface and monospace fonts by name, 12–20 px root size                | GPUI loads system fonts by family; `rems` scale with the window's rem size                                                                      | Identical                 |
| No flash on load, the paint snapshot                                     | Not needed: the theme is known before the first frame                                                                                           | Gone, as a benefit        |
| Title bar in the theme's colour                                          | Client-side title bar, as Zed draws; on Wayland we draw the window buttons                                                                       | Close                     |
| Lucide icons                                                             | `svg()` tints a single-colour SVG, which is what Lucide icons are                                                                                | Identical                 |
| Sidebar stage banners (7 SVGs with filters, patterns, masks, gradients)  | `img()` rasterises SVG with `resvg`, which handles all four. Tints are substituted into the SVG before rasterising, then cached                   | Close                     |
| Grain (PNG tiles under each surface)                                     | No tiled background. Draw the tile as repeated image quads in a `canvas`, or bake one texture per surface size                                   | Close, with care          |
| **Glass** (`backdrop-filter` blur under popovers, dialogs, sheets, toasts) | No per-element blur upstream: the renderer is single-pass ([discussion #47429](https://github.com/zed-industries/zed/discussions/47429), 2026). Window-level blur only on macOS, Windows (Mica) and KDE Wayland | **Different**             |
| Linear gradients                                                         | `linear_gradient` (two stops); no radial gradients outside `resvg` images                                                                        | Close                     |
| Container queries in the task panel                                      | Branch on the panel's measured width from the last frame                                                                                         | Identical                 |
| Markdown (GFM tables, `#N` refs, attachments)                            | GPUI Kit `TextView`, with link and image hooks                                                                                                   | Close                     |
| Stats charts (hand-rolled SVG)                                           | GPUI Kit `Chart`, or the same maths drawn with `canvas` paths                                                                                    | Close                     |
| Accessibility                                                            | AccessKit landed in GPUI in May 2026 ([zed#56065](https://github.com/zed-industries/zed/pull/56065)); unproven next to a browser's                | Probably worse at first   |

**Glass is the one visible loss.** Popovers and dialogs would sit on a translucent fill with no blur behind it.
That is what Glass opacity 100 % already shows today, so the look exists, but not the frosted one. Getting it back
means patching GPUI's renderer for a blur pass (only forks have one) or living with window-level blur, which blurs
the desktop behind the window rather than the board behind a popover.

### Motion and drag and drop

- **Panel and sidebar slides** become simpler. GPUI lays out every frame, so we animate the panel's width with
  `with_animation` and the board reflows with it. The curve today, `cubic-bezier(0.2, 0.9, 0.25, 1)`, is a
  plain function GPUI's easing accepts. The snapshot motion, View Transitions, `holdFirstFrame` and `hurryToEnd`
  machinery exists because Chromium can't lay out a full board every frame quickly. In GPUI it has no reason to
  exist, provided layout of a full board fits in a frame. That is likely, but nobody has measured it.
- **Card motion (FLIP).** GPUI has no layout animation. We'd keep each card's bounds from the last frame and,
  when they change, animate an offset from the old place to the new one. This is the same idea as `cardMotion.ts`,
  written against GPUI's element bounds: a few hundred lines.
- **Keyframe effects** (card lift, skeleton shimmer, status pulse and ping, the Autopilot sweep and glow, label
  pan): `with_animation` with `repeat()` and an easing. The sweep and glow use gradients, which are limited to
  linear ones.
- **Drag and drop.**
  - GPUI gives a drag value, a preview view that follows the pointer, and drop and hover handlers.
  - We build: the gap that opens where the card will land (animated with the FLIP above), the collision rules and
    priority-lane rules (porting the pure logic in `dnd.logic.ts`), auto-scroll near the edges, keyboard dragging,
    and the drop animation.
  - The same pieces then serve plan steps, panel sections and the sidebar's projects.
  - Expect it to feel the same once tuned. Tuning is where the time goes.
- **Dependency lines.** Curves drawn with `canvas` paths from the cards' bounds, every frame. Simpler than today's
  `ResizeObserver` bookkeeping, since GPUI hands us the bounds.

### The rich editor

Descriptions, notes and plan context are edited as rich text, stored as Markdown that round-trips byte for byte
([rich-editor.md](../features/rich-editor.md)). Nothing in the GPUI world does this:

- Zed's own editor and Markdown crates are GPL-3.0 and pull in Zed's project and workspace code.
- GPUI Kit's `TextView` renders Markdown but doesn't edit it. Its `Editor` is a code editor.
- [gpui-kit-markdown-editor](https://github.com/wabzqem/gpui-kit-markdown-editor) is a block WYSIWYG editor at
  0.1.2 (2026-11-01). It has 91 downloads and has only been tested on Linux.

The options:

1. **Source editing with a preview.** GPUI Kit's `Editor` with Markdown highlighting, beside or toggled with a
   rendered view. Cheap and robust, and it can't break the round trip, but it's a step back from today.
2. **Build our own block editor.** Paragraphs, headings, lists and task lists, quotes, code blocks, links and
   attachments, with the round trip as the test oracle (today's `richMarkdown.logic.ts` tests port). Months of
   work, mostly text input, selection, IME and clipboard.
3. **Adopt and harden gpui-kit-markdown-editor.** Cheaper than option 2 if it holds up, but it's a bet on a
   one-person, three-week-old crate.

### The art sandbox

Agents' HTML and JavaScript art runs in a locked-down iframe ([social.md](../features/social.md)). The options:

- Keep it with a `wry` webview: WebView2 on Windows, which ships with Windows 10 and 11, and WebKitGTK on Linux,
  a large dependency. We'd also have to rebuild the iframe's lockdown.
- Render only SVG art in-process with `resvg`. That's safer than today, since there are no scripts, but it
  loses animation and canvas pieces.
- Open HTML pieces in the user's browser from a sandboxed local URL.

The second and third together keep most of it without a webview.

### How close it would look

- **The same:** layout, typography, colours, every theme and its editor, contrast, fonts, icons, stage banners,
  charts, the board's structure and how it moves.
- **Close, with work:** grain, drag and drop feel, card motion, Markdown rendering, the title bar.
- **Different:** frosted glass, which becomes flat translucent surfaces; the rich editor, unless option 2 or 3
  above is done; the HTML art pieces.
- **Smoother, probably:** panel and sidebar slides and scrolling, since layout and paint no longer go through
  Chromium.

## Installing

### Linux

**Today** ([releases.md](../features/releases.md)): AppImage, deb, rpm, a tarball and a signed pacman repo. Each
carries its own Electron, so the package depends on what Chromium links against. On Arch that's `alsa-lib gtk3
libnotify nss libxss libxtst xdg-utils at-spi2-core util-linux-libs libsecret`. 290 MiB installed.

**A GPUI app** needs:

- **A GPU driver with Vulkan**, or OpenGL ES as wgpu's fallback. Since GPUI moved to wgpu (~2026-02), the Linux
  renderer asks for Vulkan or GL and prefers Vulkan (`crates/gpui_wgpu/src/wgpu_context.rs`, 2026-10). Zed's
  docs still say it "requires a Vulkan 1.3 driver" ([zed.dev/docs/installation](https://zed.dev/docs/installation))
  and suggest checking `vkcube` when it won't start ([zed.dev/docs/linux](https://zed.dev/docs/linux)). Both may
  predate the switch. Every desktop distro ships Mesa's Vulkan drivers for Intel and AMD; NVIDIA needs its
  proprietary driver or NVK.
- **Window system libraries:** `libwayland-client`, `libxkbcommon` (with `-x11`), `libxcb`/`libx11-xcb` for X11,
  and `fontconfig`/`freetype`. Every desktop install has these. No GTK, NSS or ALSA.
- **No OpenSSL**, if `reqwest` uses `rustls`.
- **glibc** at least the version on the build machine. Zed builds for 2.31 and up on x86_64.
- **For the tray**, a StatusNotifierItem host: KDE has one, GNOME needs the AppIndicator extension. Same as today.
- **WebKitGTK only if** the HTML art sandbox keeps a webview, and it's a big one. The design above avoids it.

**Machines with no usable GPU** (VMs, remote desktops, old laptops) are the risk. The fallbacks:

- wgpu can use Mesa's software Vulkan (lavapipe) or GL (llvmpipe). Zed warns that it "will make Zed run very
  slowly", and nobody has published how a board would fare.
- The `serve` subcommand needs no GPU at all, so agents keep working. Without a browser UI there would be
  nothing to look at the board with, which is an argument for keeping a web UI available in some form.

**Packaging:** the same formats, built with `cargo-packager` or `cargo-deb` plus `cargo-generate-rpm`. The
AppImage gets much smaller. The pacman package becomes a plain binary with a short `depends`. Flatpak becomes
reasonable, but the tray and launching terminals and agent CLIs from inside the Flatpak sandbox would need
`flatpak-spawn --host`. That's a real cost for a board that runs `git`, `gh` and `claude`, so skip Flatpak.

### Windows

**Today:** a per-user NSIS installer, unsigned, so SmartScreen warns on first run. There's no auto-update.

**A GPUI app** needs:

- **Direct3D 11** at feature level 10_1 or better, which any GPU from the last 15 years has, and Windows 10 1903+
  or 11 22H2+ for Zed ([zed.dev/docs/windows](https://zed.dev/docs/windows)). In a VM it falls back to Microsoft's
  software adapter (WARP), which works but slowly, and Zed flags it as an emulated GPU.
- **Nothing else.** No WebView2 unless the art sandbox keeps a webview. WebView2 ships with Windows 10 and 11
  anyway.

**Packaging:** `cargo-packager` produces NSIS (as now) or MSI. Zed uses Inno Setup and winget. Signing is the
same unsolved question as today; Zed signs through Azure Trusted Signing. Auto-update is no harder or easier than
with Electron.

### Compared

|                              | Today (Electron)                          | Rust + GPUI                                                                  |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Download / installed         | ~100 MB / 290 MiB                         | ~10–25 MB / 25–60 MB (estimate)                                              |
| Linux runtime dependencies   | GTK 3, NSS, ALSA, libsecret, X libraries… | Vulkan or GL driver, Wayland/X11, xkbcommon, fontconfig                      |
| Machines without a GPU       | Chromium falls back to software and works | Software Vulkan/GL or WARP: works slowly, unmeasured; `serve` still fine     |
| Windows                      | Windows 10+, NSIS                          | Windows 10 1903+, DX11, NSIS or MSI                                          |
| Building from source         | Node and pnpm; `pnpm install` is quick     | Latest stable Rust (GPUI requires it), and on Linux the `-dev` headers for the libraries above |

**Building from source gets heavier.** A clean release build of a GPUI app with wgpu, tree-sitter grammars, axum
and rusqlite takes minutes and several GB of `target/`, against seconds for today's TypeScript. CI and agents
would feel this: every worktree has its own `target/` unless they share a cache. Incremental builds are faster,
but nothing like Vite's hot reload.

## Effort

Rough person-months for one developer fluent in Rust, working with agents, to reach today's features. These are
judgement, not measurement. GPUI's weekly API churn and agents' thinner knowledge of it are already counted in
the UI rows.

| Area                                                                                                | Person-months |
| --------------------------------------------------------------------------------------------------- | ------------- |
| Shared crate: types and validation from contracts, prompts, the embedded skill, keybindings         | 0.5–1         |
| Server: routes, SSE, SQLite, services, MCP with identical tool text, Autopilot, integrations, tests | 3–5           |
| GPUI groundwork: app shell, theme system, primitives on GPUI Kit, routing and URL state             | 1–2           |
| The board: lanes, epics, cards, filters and views, drag and drop, motion, dependency lines          | 2–3           |
| The task panel: plan timeline, links, reviews, sessions, Markdown                                   | 1.5–2.5       |
| Settings, Autopilot (with the script editor), stats, notifications, command palette, the rest       | 2–4           |
| The rich editor: source and preview (option 1) or our own block editor (option 2)                    | 0.25–3        |
| Tray, login items, packaging and CI on Linux and Windows                                            | 0.5–1         |
| **Total**                                                                                           | **~11–21**    |

The server is the safest estimate: the code is plain logic and the tests specify it. The UI is the widest range,
because so much of it is building what React, dnd-kit and the browser give us now.

## Ways to get there

1. **All at once.** Freeze features, rewrite, switch. Not recommended: a year with nothing shipped, and no way
   to compare the two servers on real use.
2. **The server first, then the window** (recommended if we go ahead).
   1. Write the Rust server against the same REST, SSE and MCP contract and the same SQLite file. The Electron
      shell starts it instead of `server.mjs`, and the React app doesn't change.
   2. Prove it the cheap way: run the existing HTTP route tests against both servers, and compare MCP tool
      output for a recorded set of calls character by character, since agents read that text.
   3. The always-on part drops from ~96 MB to a few tens of MB, and Node leaves the runtime. Users notice
      nothing, which is the point.
   4. Then build the GPUI window as a client of that server, opt-in at first beside the web UI, and retire Electron
      once it covers everything.
   5. The Rust server can keep serving the web build, so the board in a browser needn't be lost. The price is two
      UIs to keep in step: freeze the web one, or keep it as a read-mostly fallback.
3. **The Rust server with a system webview (Tauri) instead of GPUI.** It keeps the React UI and most of the
   install-size win. But on Linux the webview is WebKitGTK, which handles our Chromium-tuned motion (View
   Transitions with `match-element`, compositor-only slides) and `backdrop-filter` worse than Chromium, so the
   board would likely look and move worse on the platform most users have. Worth knowing as the cheap option;
   not a good fit for this UI.

## Open risks and unknowns

1. **How GPUI ships.** The official `gpui` crate stopped at 0.2.2 (2025-10-22). Since then Zed split it into
   `gpui_platform`, `gpui_linux`, `gpui_windows` and `gpui_wgpu`, none of them on crates.io. Apps outside Zed use
   Longbridge's weekly `gpui-pre` snapshots (0.3.11, 2026-11-02), pinned with `=` because loose version
   requirements have broken builds ([crates.io](https://crates.io/crates/gpui-pre),
   [gpui-kit Cargo.toml](https://github.com/longbridge/gpui-kit/blob/main/Cargo.toml)). The README says GPUI is
   "pre-1.0. There will often be breaking changes between versions".
2. **Machines with no usable GPU.** Software Vulkan/GL on Linux and WARP on Windows work, but slowly, and nobody
   has measured them for an app that stays open all day.
3. **The rich editor.** See [The rich editor](#the-rich-editor).
4. **Tray and GPUI together on Windows.** No published GPUI app shows a tray alongside GPUI's message loop.
5. **Accessibility and IME** on Linux, both new to GPUI in 2026.
6. **Memory with wgpu.** The ~100 MB empty-window floor could eat into the memory win while the window is open.
7. **Agents writing GPUI.** Fewer examples to learn from and a moving API mean more correction per change than
   React gets today.

## What would change the answer

- Zed publishing the split GPUI crates again, or a snapshot line that stops breaking every week.
- A WYSIWYG Markdown editor for GPUI with real users, or a decision that source editing with a preview is enough.
- Measurements from a short spike: the board, the panel slide and card dragging on `pnpm sandbox --seed dense`'s
  data. Frame times and memory on a Linux GPU, Linux `llvmpipe`, Windows, and Windows under WARP. That spike is
  the next step if the window is pursued. It was out of scope here.
