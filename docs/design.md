# Design system

The interface has two sources:

- **Structure.** The Figma community kit the organisation chose, "Main Dashboard" (Constructor X;
  Hivamis task 3). The file was read directly. Its variables (`Color Mode` in Light and Dark,
  `Radius`, `Font Size`, `Font Weight`, `Spacing`) and its dashboard frames (1600, 768 and 360 wide,
  light and dark) set the layout and the components.
- **Look.** The refresh asked for on the third list (item 7): glass over a soft pastel light, in
  both themes.

All values live as tokens in `apps/web/src/index.css`. Dark mode redefines the tokens only, so no
component carries its own dark style. The status tints are the one exception (see below).

## Light and glass

- **The light.** Five pastel glows (lavender, blush, mint, sky, apricot) are painted once, fixed,
  behind everything (`body::before`), over a pale `canvas`. At night the canvas is a deep indigo and
  the same glows are turned low.
- **Glass.** Cards and panels are `bg-surface`: white at 72% (night: indigo at 55%), blurred and
  saturated over the light (`backdrop-filter`), with a bright `edge` ring and a soft violet-tinted
  shadow (`shadow-glass`). Every `rounded-xl bg-surface` element, and anything marked `.glass`, is
  blurred.
- **Overlays** (dialogs, drawers, menus, popovers, the owl's panels) use `bg-panel`: white at 90%
  (night: 94%). Over a dimmed page, the text keeps its contrast.
- **Transparency** turns solid in three cases (ADR-081):
  - the reader has asked for less transparency (`prefers-reduced-transparency`);
  - the browser cannot blur;
  - the device is too slow to blur every frame. `lib/power.ts` marks `data-power="low"` on a
    device with four cores or fewer, or one whose frames already take over 20 ms at the median.
- **Every blur is a token.** The glass uses `--glass-blur`; the dimmed page behind a dialog or
  drawer uses `--scrim-blur`, through `.scrim`. Each fallback sets both to `none`, so none is
  missed. A test refuses a Tailwind `backdrop-blur-*` class or a literal `backdrop-filter`.
- **Containing box.** Blur makes a panel the containing box of anything `fixed` inside it. So every
  full-screen overlay is rendered at the root of the page: `Modal`, the assistant, the written guide.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#f5f3fb` | `#0d0c1a` | the page, under the light |
| `surface` | white 72% | indigo 55% | glass: cards, panels, controls. 72% so text keeps its contrast over the strongest glow (ADR-081) |
| `panel` | white 90% | indigo 94% | overlays |
| `edge` | white 85% | white 9% | the lit edge of glass |
| `ink-50` … `ink-900` | `#f7f6fc` … `#16142a` | `#1c1a30` … `#ffffff` | neutrals with a breath of violet. 400 and darker are text, and each keeps 4.5:1 over the glass at its darkest; 300 and lighter are lines and fills (ADR-081) |
| `brand-*` | periwinkle, `brand-600` = `#5d4ee0` | lifted, `brand-600` = `#988cff` | links, focus, selection, tints |
| `--grad-accent` | violet `#6150ea` → blue `#336bd0` | the same | the main action (`.btn-accent`), the logo, the user's chat bubble, a chosen toggle. White text keeps 4.5:1 at every stop |
| `--grad-soft` | the accent at 16% → 10% | at 24% → 14% | the chosen item (`.soft-selected`): menu, tab, guide section |

## Shape, type and elevation

- **Glass is rounded.** Cards are 20px (`rounded-xl`), controls 12px (`rounded-lg`), small marks 8px.
  Status badges are pills. The kit's cards were square; the glass refresh replaced that.
- **Controls** are 32–36px. The main action is the accent gradient with white text. Others are glass
  with an edge (`secondary`) or bare (`ghost`). Fields are glass and turn near-opaque while focused.
  Search is a pill.
- **Type.** The typeface is Ray (Maryamsoft; the organisation holds the licence), one variable font
  for Persian and Latin, weights 300–950, served from `public/fonts/Ray-VF.woff`. Vazirmatn
  (self-hosted, SIL OFL) is the fallback. The scale is raised: `text-xs` 13px on a 20px line,
  `text-sm` 15px on 24px. Nothing is set below 12px, and chart labels are set in Ray.
- **Layers.**
  - Page popovers: z-50.
  - The owl and its tour: 54–56.
  - Drawers (the assistant, the written guide): z-[60], above the owl.
  - Dialogs: z-[70], rendered into the document body.
  - Toasts: z-[80].
- **Tabs** are bold grey labels; the chosen one sits in the soft wash of the accent. Page-level tabs
  sit on a glass strip of their own.
- **Status colours** keep the platform's one status scale (neutral, blue, amber, green, red). The
  rose, amber, emerald and sky palettes are tokens too. In the dark, their tints (50–200) are the
  colour washed over the card and their text shades (700–900) are light, so every badge and notice
  box reads there. Fills (600) keep their colour.

## The logo

The owner's logo (2026-10-16, ADR-094): the **mark** — rings wound by a key — and the **wordmark**
«Hiva» over «Branding|Creativity» in a light monospaced type. The artwork is kept in `docs/brand/`
(`hiva-logo-light.webp`, `hiva-logo-dark.webp`). It is traced into paths in
`packages/contracts/src/brand.ts` by `apps/api/scripts/brand-trace.mjs`, so it is sharp at every
size and needs no font.

- **Ink only.** Black on light, white on dark, as the artwork shows both. In the app the logo takes
  the text colour (`text-ink-900`, which turns white in the dark theme). It is never recoloured to the
  accent and never put on a gradient, except the phone app's bar, where it is white.
- **Never mirrored.** In a right-to-left page the key still points right, as drawn.
- **Sizes.**
  - The whole lockup only where it has room: the sign-in page, PDFs, mails. Below about 110px tall
    its tagline cannot be read.
  - The mark alone at 28–56px: the sidebar, the phone bar, the public pages.
  - Below 32px, the mark drawn for small sizes (`public/icon-small.svg`): three rings and the key,
    for the browser tab.
- **Type.** The wordmark's type exists only inside the drawing. The interface keeps Ray (above): it
  is the organisation's chosen and licensed face, and the wordmark's mono is a Latin display face
  with no Persian.
- **Where it is.**
  - In the app: the sidebar with «هیوامیس», the phone bar, the start-up screen, the sign-in, sign-up,
    activation and Google pages, the phone app, the Telegram Mini App, the client portal, and the
    approval and e-signature pages.
  - Outside it: every PDF's masthead (vector) and running footer (the mark), and every mail's head (a
    PNG on the installation's address, `public/brand/hiva-logo-email.png`, with alt text).
  - The app's icons, below.

## The icon

The installed app's icon is the Hiva mark in white on a near-black tile (#111111), as the dark
artwork has it. It is drawn once, in `apps/web/public/icon.svg`; the tab's small mark is
`public/icon-small.svg`. `pnpm icons` makes every PNG from them (ADR-080, ADR-094):

- the plain and the maskable icon;
- Apple's touch icon;
- the 32px favicon (from the small mark);
- the white notification badge;
- the mail logo.

Change an SVG, then run `pnpm icons`; a test fails until the PNGs match.

## Layout and the kit's components

- **Sidebar**, 248px: the logo, navigation in labelled groups, and the person's card at the foot.
  - On a desktop it is a floating pane of glass and folds to a 64px rail of icons; each viewer's
    choice is remembered on their device.
  - As in the kit, an item shows a count where something waits: «کارهای من» shows everything in the
    queue, «فرم‌ها» the forms waiting for the person's decision. The counts come from the same query
    the queue reads, kept fresh by the live channel.
- **Top bar**, 64px, a pane of glass: search at the start, icon buttons and the gradient «+» at the
  end. On a phone the bar shows the menu, the logo and the essential icons, and search opens over
  the bar.
- **Page head.** As in the kit's "Name Project" box, each page starts with its title, subtitle and
  actions in a pane of their own.
- **Metric tiles.** The icon sits on a pastel tile in the tone's colour, then the label and the
  figure; the hint sits in a footer row under a hairline, where the kit sets its trend line.
- **Cards.** A header (title, subtitle, action) and, as in the kit, an optional footer bar
  ("View more" and the like), held to the bottom when the card is stretched to its row. The
  dashboard's tasks and projects cards use it.
- **Page footer.** As in the kit: the product, the year (Solar Hijri in Persian), and links to the
  guide, the organisation's rules and the person's own page. Its far end is left clear for the owl.
- **Content** is a centred column, up to 1400px.
- **Charts** follow the kit's cards. The half gauge (`components/Gauge.tsx`) shows a share with a
  legend of dots; the dashboard uses it for the deadlines on track.
