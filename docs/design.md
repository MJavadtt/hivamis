# Design system

Hivamis task 3. The interface follows the Figma community kit the organisation chose, "Main
Dashboard" (Constructor X). The file was read directly: its variables (`Color Mode` in Light and
Dark, `Radius`, `Font Size`, `Font Weight`, `Spacing`) are the source of the values below, and its
dashboard frames (1600, 768 and 360 wide, light and dark) are the reference for layout.

All values live as tokens in `apps/web/src/index.css`. Dark mode redefines the tokens only, so no
component carries its own dark style. The status tints are the one exception (see below).

## Colour

| Token | Light | Dark | From the kit |
|---|---|---|---|
| `canvas`: the page | `#ffffff` | `#010101` | Background/background-0 |
| `surface`: cards, panels, inputs | `#ffffff` | `#1a1a1a` | Base/base-0 |
| `ink-50` / `ink-100`: subtle fills, hover, table header | `#f7f7f7` / `#f2f2f2` | `#1f1f1f` / `#262626` | base-30, base-50 |
| `ink-200`: every border and divider | `#e6e6e6` | `#333333` | base-100 |
| `ink-400`: placeholders, quiet icons | `#999999` | `#808080` | base-400 |
| `ink-500`: secondary text | `#737373` | `#a6a6a6` | base-550, one step darker than the kit's base-500, so small grey text keeps 4.5:1 on white |
| `ink-600` … `ink-800`: body text | `#666666` … `#333333` | `#cccccc` … `#f2f2f2` | base-600 … base-800 |
| `ink-900`: headings, and the main button | `#010101` | `#ffffff` | base-900 |
| `brand-*`: links, focus, selection, charts | blue, `brand-600` = `#2563eb` | lifted, `brand-600` = `#3b82f6` | Primary (Blue mode) |

The kit offers other primaries (Pink, Indigo, Emerald) and grey themes (Blue Gray, Yellow Gray).
Changing the `brand-*` or `ink-*` values in `index.css` switches the whole interface to one of them.

## Shape, type and elevation

- **Cards are square**, with a 1px `ink-200` border and the kit's one shadow (`0 1px 2px` grey at
  10%). In Tailwind terms `rounded-xl` is the card radius, and it is 0. Controls keep 8px
  (`rounded-lg`), small marks 6px and 4px, avatars and icon buttons are round.
- **Controls are 32px.** Buttons are 32 (28 small). The main action is the kit's dark button:
  black on light, white on dark, with a faint blue glow. Others are outlined (`secondary`) or bare
  (`ghost`). Inputs are 32 with the shadow.
- **Type.** The kit sets small labels bold (10–12px, grey) and figures semibold at 20px. Persian
  script needs one step more at that size, so labels here are 11–13px, still bold and grey. The kit's
  typeface is Inter, which has no Persian; Vazirmatn (self-hosted) sets both scripts.
- **Tabs** are bold grey labels; the selected one sits in an outlined box, with no underline.
- **Status colours** keep the platform's one status scale (neutral, blue, amber, green, red). The
  rose, amber, emerald and sky palettes are tokens too: in the dark their tints (50–200) are the
  colour washed over the card and their text shades (700–900) light, so every badge and notice box
  reads there. Fills (600) keep their colour.

## Layout

- **Sidebar**, 248px: the logo, navigation in labelled groups (32px items with 18px icons), and the
  person's card at the foot. On a desktop it folds to a 64px rail of icons; each viewer's choice is
  remembered on their device.
- **Top bar**, 64px: search at the start, icon buttons and the dark «+» at the end. On a phone the bar shows the menu, the logo and the essential icons, and search
  opens over the bar.
- **Content** is a centred column (up to 1400px). Each page starts with a head line (title,
  subtitle, actions) over a hairline.
- **Charts** follow the kit's cards. The half gauge (`components/Gauge.tsx`) shows a share with a
  legend of dots; the dashboard uses it for the deadlines on track.
