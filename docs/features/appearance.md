# Appearance: themes, contrast, glass, motion and fonts

Board task: #173 (epic #178). Verified against T3 Code at commit `812b7006f8` (October 2026).

Settings → Board → Appearance holds the same look-and-feel options as T3 Code's Appearance page, so the board
and T3 Code look the same side by side. You pick an appearance mode (System, Light, Dark) and a theme: T3 Code
(the default), T3 Chat, Grove, Ocean, Ember or Iris, for both appearances or just one. Below that are sliders
for contrast, glass opacity and panel animations, and the interface and monospace fonts. Everything is kept in
the browser; the server never sees it.

## How it works

### Themes

A theme is T3 Code's model, unchanged: an id, a label, a base `appearance` with 61 colour roles (`canvas`,
`surface`, `text`, `accent`, `sidebar`, `messageAction`, …), and optional `variants` for the other appearance.
The five built-ins in `apps/web/src/theme/palettes.ts` are copied verbatim from T3 Code's
`packages/shared/src/themePalettes.ts`. **T3 Code** isn't a theme object: it is the board's own CSS tokens,
which were already T3 Code's, so choosing it applies nothing.

The user's choice is three things:

| Choice     | Storage key (`storageKey()`) | Meaning                                                                       |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Mode       | `theme`                      | `light`, `dark` or `system` (the key the old toggle used, so saves carry over) |
| Base theme | `theme-id`                   | The theme for both appearances; absent is T3 Code                             |
| Halves     | `theme-halves`               | `{ light?, dark? }`: a theme for one appearance, overriding the base          |

Clicking a card sets the base and clears the halves. Clicking one orb on a card sets only that half. Picking
T3 Code's orb while a themed base is set turns the base into an explicit half on the other side, so that side
keeps its theme and this side falls back to T3 Code (T3 Code's `assignHalf`). A theme with colours for only
one appearance forces that appearance unless a half covers the one the mode asks for. All of this is pure
logic in `theme/themeState.logic.ts`.

Saved custom themes are read from `themes` (a list in T3 Code's stored shape, parsed leniently) and shown as
cards. Nothing in this task writes that key: creating and importing themes is #179.

### Applying a theme

`useTheme` (`apps/web/src/hooks/useTheme.ts`) resolves the appearance, toggles `.dark` on `<html>`, and for a
theme sets `data-theme-id` plus one inline `--app-theme-*` variable per role (`applyThemePalette` in
`theme/applyTheme.ts`). The `html[data-theme-id]` block in `index.css` maps those onto the board's tokens:
canvas → `--background`, surface → `--card`, text → `--foreground`, `messageAction` → `--primary` (solid
controls), focus → `--ring`, and error, warning and update roles onto their status tokens. A second block does
the same inside `[data-app-sidebar]`, which sets its own palette. Success, info, label, epic and PR colours
stay fixed. Terminal, composer, search-match and toolbar roles are kept in the data but nothing maps them.

Each built-in also tints the sidebar banner's night art (`--stage-night-*`), and T3 Chat gets its finer grain
tile, both copied from T3 Code.

Storage events on any of the keys re-apply, so other tabs follow. The OS appearance is watched for System.

### No flash on load

The palettes live in the JS bundle, so the boot script in `apps/web/index.html` can't resolve a theme itself.
Instead `useTheme` saves a **paint snapshot** (`theme-paint`) every time it applies: for each appearance the
mode can ask for, the appearance actually shown, the theme id, its variables already named, and its canvas.
The boot script reads the mode, picks the entry for the wanted appearance and paints it before first paint.
The appearance prefs get the same treatment through `appearance-paint` (below). Vite fills the keys in with a
`%STORAGE_KEY(name)%` placeholder (`brandHtml` in `apps/web/vite.config.ts`).

### The desktop title bar

The shell paints its window background and title bar overlay before the page does. `useTheme` sends it two
things: `setTheme` (the appearance its native controls follow; `resolveDesktopTheme` pins a single-appearance
theme's appearance) and `setBackgroundColor`, the theme's canvas as `#rrggbb` (converted with a 1px canvas,
because Electron doesn't take oklch). The main process accepts only `#rrggbb` from the board's origin and
re-applies it on every theme change and on show. `setBackgroundColor` is optional on `DesktopBridge`: an older
shell's preload doesn't have it.

### Contrast, glass, panel animations and fonts

These are prefs in the `useAppearance` store (`state/ui.ts`, persisted under `appearance`, clamped by
`normalizeAppearancePrefs`). `theme/appearance.ts` turns them into inline styles and data attributes on
`<html>` with `appearancePaint` (`theme/appearance.logic.ts`) and saves the same object as `appearance-paint`.

| Setting          | Range       | Default | What it drives                                                                                    |
| ---------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------- |
| Contrast         | 50–200 %    | 100 %   | `--appearance-contrast-base/boost/border-boost`, read by the `--contrast-*` block                 |
| Glass opacity    | 40–100 %    | 80 %    | `--glass-opacity`; at 100 % also `--glass-blur: 0px`                                              |
| Panel animations | 0–400 ms    | 0 ms    | `--panel-animation-duration` and `data-panel-animations` (`false` under reduced motion)           |
| Interface font   | name; 12–20 px | system, 16 px | `--font-sans`; the size is the root font size, so every rem scales                         |
| Monospace font   | name        | system  | `--font-mono`                                                                                     |

**Contrast** uses T3 Code's formulas: below 100 % each foreground mixes toward its surface and each border
toward transparent; above it they mix toward black or white (borders a quarter as fast). The `--contrast-*`
variables are defined on `:root` and again on `[data-app-sidebar]`, and Tailwind's foreground, border and input
colours read them (`@theme inline`), so every `text-foreground`, `text-muted-foreground` and `border` follows.

**Panel animations**: the ported sidebar primitive already transitions when an ancestor has
`data-panel-animations="true"`. The task panel grows in from its edge with the `.panel-enter` keyframe;
closing it is instant.

**Fonts** are typed by name and applied on Enter or blur, only if the browser can draw the family (and, for
the monospace font, if it is monospaced): T3 Code's canvas probes in `theme/fonts.ts`.

## Decisions

- **Copy T3 Code verbatim.** Same roles, palettes, file format, CSS mapping and formulas, so a theme means the
  same thing in both apps and a T3 Code theme file will import unchanged (#179).
- **Web only.** The server never reads a theme, so nothing is in contracts except the desktop bridge method.
- **A paint snapshot, not palettes in `index.html`.** Duplicating 61 roles × 10 palettes in the boot script
  would drift; the snapshot is whatever the app last applied, so custom themes work too.
- **No colour library.** T3 Code canonicalises colours with culori. The board only needs to know a value is a
  literal colour that can't escape its custom property, which a regex checks (`isThemeColor`).
- **A native range input**, as T3 Code uses, rather than Base UI's Slider.
- **The mode key stays `theme`.** The old toggle's saves keep working; the theme id is a new key.
- **Settings the board skips:** environment identification, composer context, chat width, diff colours, word
  wrap, and the prompt and terminal fonts. The board has none of those surfaces.

## Alternatives considered

| Option                                                  | Why not chosen                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Store theme choices in server settings                  | Per-browser like T3 Code's; the server has no use for them               |
| A transition on the task panel's width                  | Dragging its edge would lag behind the pointer                           |
| Inline the built-in palettes in the boot script          | Duplicated data that drifts, and no answer for custom themes             |

## Code map

| File                                                        | What it does                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/src/theme/palettes.ts`                            | Roles, types, T3 Code's colours, the five built-ins, role → variable |
| `apps/web/src/theme/themeFile.ts`                           | T3 Code's theme file: parse, serialize, stored themes, colour check  |
| `apps/web/src/theme/themeState.logic.ts`                    | Resolving the appearance and theme, halves, the paint snapshot       |
| `apps/web/src/theme/applyTheme.ts`                          | Writing a palette to `<html>`; colour → hex for the shell            |
| `apps/web/src/hooks/useTheme.ts`                            | The theme store: storage, apply, tabs, OS changes, the shell         |
| `apps/web/src/theme/appearance.logic.ts`, `appearance.ts`   | Contrast, glass, animation and font prefs and applying them          |
| `apps/web/src/theme/fonts.ts`                               | Whether a font family is installed / monospaced                      |
| `apps/web/src/theme/themePreview.ts`                        | How a card's orbs are drawn                                          |
| `apps/web/src/components/settings/AppearanceSection.tsx`    | The Appearance settings                                              |
| `apps/web/src/components/settings/ThemeLibrary.tsx`         | Mode tiles and theme cards                                           |
| `apps/web/src/components/settings/ThemePreviewCircles.tsx`, `ThemeWireframe.tsx`, `PanelAnimationsPreview.tsx` | Copied T3 Code previews |
| `apps/web/src/components/ui/slider.tsx`                     | The settings slider                                                  |
| `apps/web/src/index.css`                                    | `html[data-theme-id]` mapping, `--contrast-*`, `.settings-slider`, `.panel-enter` |
| `apps/web/index.html`                                       | The boot script                                                      |
| `apps/desktop/src/main.ts`, `titleBar.ts`, `preload.ts`     | `desktop:set-background` and the window colours                      |
