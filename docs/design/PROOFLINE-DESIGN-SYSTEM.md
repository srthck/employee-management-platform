# The Proofline: PayGuard public-site design system

Scope: the public site (`/`), sign-in and registration, and the signed-in application. Shared tokens live in
`frontend/src/styles/tokens.css`; site-only layout is in `frontend/src/components/site/site.css` (scoped to
`.pg-site`); application components are in `frontend/src/index.css` and `frontend/src/components/ui/`.

## 1. Thesis

PayGuard makes a payroll result understandable by connecting it to the records and decisions that produced
it. The site turns that into one device: a signal-red line that runs from a result to its evidence
(inputs → statutory rules → variance check → approval → frozen record). The same line marks each section,
connects the run-lifecycle states and closes the page. It always means "this is connected to that".

## 2. Research principles (extracted, not copied)

| Source | Principle applied |
|---|---|
| Apple HIG, Typography; WWDC20 "The details of UI typography" | Hierarchy from size, weight and leading together; separate optical treatment for display and text sizes; hierarchy through layout and grouping rather than decoration. |
| Linear, "How we redesigned the Linear UI" and "Behind the latest design refresh" | "Don't compete for attention you haven't earned": not every element gets equal weight; reduce chrome; identity through constraints. |
| Stripe (public storytelling roles; product pages) | Show the mechanism of a technical product with a concrete, specific example instead of abstract claims. |
| Gusto and similar payroll products (third-party walkthroughs) | Payroll is understood as a sequence of steps ending in approval; show the workflow, not a dashboard. |
| web.dev, Core Web Vitals thresholds | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at the 75th percentile of field data. |
| W3C, WCAG 2.2 (2.4.11, 2.5.8) | Focus must not be hidden by sticky UI; pointer targets at least 24×24 px. |

Mercury's own design sources were not found; only a third-party reconstruction was, so it was not used.

## 3. Audit of the previous page (cause of the generic look)

- The headline was the brand name. The page never said what the product does for the reader.
- It claimed **ML-based anomaly detection** and "Predict". There is no machine learning in the code; the
  variance report is a deterministic, rule-based explanation of pay changes.
- The visual was a generic overview card: an unlabeled ₹24.8L figure, seven unlabeled bars, "+8.4%" with
  no referent, and a hard-coded green **"Integrity verified"** that no verification produced.
- The "Live" badge mixed API reachability with data state, and its text stayed green when offline.
- "DM Sans" was declared but never loaded, so the page rendered in the system fallback.
- One brand red (`#A6192E`) on the page and another (`#C62828`) in the app; the Tailwind `primary` palette is blue.
- Layout was a two-column hero plus a three-column feature strip: the default SaaS template.

## 4. Concepts considered

**A. The Proofline (chosen).** A sample payslip result with a red line tracing it to five evidence
stages; selecting a stage opens that evidence and moves the trace. Sections continue the line.
Mobile: the same vertical chain, so nothing depends on width or hover.

**B. The Annotated Payslip.** One large printed payslip with red editor's-pen margin notes citing the rule
version behind each line. Very clear and ownable, but it shows a document, not a process: approval, variance
and the frozen record have no natural place in the margin. Margin notes collapse into footnotes on mobile,
losing the idea.

**C. Night Ledger.** A dark, immersive horizontal timeline of the run state machine with glowing red
transitions. Energetic, but it relies on horizontal scrolling, carries contrast risk on dark red, reads like
a generic dark fintech theme, and puts the state machine ahead of the payroll result people care about.

| Criterion | A | B | C |
|---|---|---|---|
| Ownability | High | High | Low |
| Immediate understanding | High | High | Medium |
| Payroll credibility | High | High | Medium |
| Evidence visualization | Full chain | Rules only | States only |
| Responsive / accessible | Same structure at all widths | Margin notes degrade | Horizontal scroll |
| Performance / complexity | Low (CSS + one measured line) | Low | Medium |

A was chosen; B's idea of citing the exact rule version survives inside A's "Statutory rules" stage, and
C's state machine appears as section 02, in a calmer form.

## 5. Typography

| Role | Face | Licence | Rules |
|---|---|---|---|
| Display, headings, body | the system face, falling back to Inter Variable (`@fontsource-variable/inter@5.2.5`, `opsz` build) | SIL OFL 1.1 | weight 400–700; tracking follows size (below) |
| Evidence, metadata, amounts in tables | the system mono, falling back to IBM Plex Mono 400/500 | SIL OFL 1.1 | 10–13 px, uppercase labels +0.07em |

**Why the stack is ordered this way.** Apple's SF Pro is licensed for Apple
platforms only and may not be self-hosted on the web, so the stack asks for
the system face first:

```
-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, …
```

That renders genuine SF Pro on Apple devices and Segoe UI Variable on
Windows 11, with no licence problem, and falls back to self-hosted Inter —
the closest open face to SF — everywhere else. The mono stack does the same
via `ui-monospace, SFMono-Regular`.

**Optical sizing.** Inter carries an `opsz` axis, the same idea as SF's
Text/Display split, and `font-optical-sizing: auto` drives it: small text
opens up slightly, display text tightens. Both faces are self-hosted, so
there is no third-party font request.

**Tracking scale** (`--pg-track-*` in tokens.css). Letter-spacing tightens as
size grows, which is what makes large type read as deliberate rather than
merely big:

| Step | Tracking | Used by |
|---|---|---|
| display | −0.045em | hero, `.t-display` |
| title | −0.028em | `.page-title` |
| heading | −0.018em | `.section-title` |
| body | −0.006em | body copy |
| small | 0 | buttons, badges |
| micro | +0.07em | eyebrows, table heads, uppercase labels |

Headings use `text-wrap: balance`. Proportional figures make columns ragged,
so tabular contexts (`.tabular`) switch to the mono face with
`font-variant-numeric: tabular-nums`.

## 6. Colour

Colour lives in `frontend/src/styles/themes.css`; everything structural —
type, space, radii, blur, motion — lives in `tokens.css` and never varies by
theme. Tailwind reads the same values (`tailwind.config.js`), so `text-ink-2`
and `var(--pg-ink-2)` are one colour.

**Four themes**, selected by `data-theme` on `<html>` and persisted per
browser (`contexts/ThemeContext.jsx`, picker in the account menu). An inline
script in `index.html` applies the stored choice before first paint, so the
page never flashes the default on its way to the chosen one.

| Theme | Canvas | Accent | For |
|---|---|---|---|
| `midnight` (default) | deep navy, warm bloom | coral `#FF6A5C` | the brand look |
| `graphite` | neutral charcoal | Apple blue `#4C9DFF` | the quietest, for long sessions |
| `aurora` | indigo | violet `#A78BFA` | — |
| `daylight` | white glass on a tinted canvas | `#0066CC` | bright rooms, printing |

No accent collides with a status colour, so a tinted control is never
mistaken for "verified", "action required" or "failed". The table below is
the `midnight` palette; the other three follow the same token names.

The canvas is a deep navy lit from the left by a warm bloom; surfaces are frosted glass over it; a single
coral carries every action and accent. Ratios are measured against the panel surface (#101B31) unless noted.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `obsidian` | #050912 | the backdrop behind the shell, recessed field wells | — |
| `wine` | #13264A | deep brand bands | — |
| `crimson` | #FF6A5C | primary actions, links, accent rules, the proof point | 6.6:1 as text on the canvas |
| `crimson-strong` | #FF867A | hover / pressed (lighter, not darker, on a dark canvas) | — |
| `scarlet` | #FF8D7D | graphics only: lines, nodes | — |
| `on-accent` | #2A0A06 | text and icons **on** coral fills | 6.5:1 on crimson |
| `porcelain` | #0A1424 | page canvas | — |
| `canvas-2` | #131F38 | quiet fills | — |
| `surface` | #101B31 | panels (the glass film sits over this) | — |
| `ink` / `ink-2` | #F2EBE6 / #A4B0C4 | text / secondary text | 14.4:1 / 7.9:1 |
| `ink-3` | #76839A | placeholders and disabled only | 4.4:1 |
| `line` / `line-strong` | #22304C / #33425F | separators / control outlines | decorative |
| `field` | #3A4A68 | input borders | — |
| `ok` | #5FD79B | verified / resolved | 9.7:1 |
| `warn` | #F2B55C | action required | 9.6:1 |
| `bad` | #FF8178 | failed / error | 7.3:1 |
| `defer` | #93A1B8 | deferred / out of scope | 6.3:1 |

Coral is used for connection and action only. Because white on coral reaches only 2.8:1, filled coral
controls take `on-accent` (dark warm ink), not white. Status is never colour-alone: every status carries
text and an icon (see §11).

### 6a. Atmosphere

Three tokens produce the lit canvas, and nothing else should hand-roll it:

| Token | What it is |
|---|---|
| `--pg-canvas-gradient` | the base ramp, lighter at the top |
| `--pg-bloom` | a warm light leak at centre-left, a cool one at top-right, and a floor vignette |
| `--pg-pinstripe` | 3px vertical corduroy laid over everything |

`.pg-canvas` (application) and `.hero-shell` (site) apply all three.
`--pg-canvas-solid` is the flat equivalent, used wherever effects are off.

Each theme also separates three colours that are easy to conflate:
`--pg-backdrop` (behind the shell), `--pg-obsidian` (the scrim ink, dark in
*every* theme so sheets still dim what is behind them, including in
Daylight) and `--pg-well` (the recessed fill inside inputs).

### 6b. The material model

Three layers, and the distinction is load-bearing. Apple's own guidance is
that the glass material belongs to *"the navigation layer that floats above
the content of your app"*, and that it should not be applied to lists,
tables or content, nor stacked on itself.

| Layer | What it is | Blur? | Class |
|---|---|---|---|
| Canvas | the lit gradient, bloom and pinstripe | no | `.pg-canvas`, `.hero-shell` |
| Content | panels holding data: tables, lists, figures | **no** | `.panel` |
| Floating | top bar, pill nav, drawer, dialogs, the hero stack | yes | `.glass`, `.glass-strong`, `.dialog`, `.panel-float` |

Content surfaces are near-opaque (`--pg-surface-translucent`, 0.72) and carry
no `backdrop-filter`. That is deliberate on both counts:

- **Contrast becomes deterministic.** Text over a blurred backdrop has a
  contrast ratio that depends on whatever happens to be behind it. Over a
  known surface colour it can be guaranteed. Every colour in themes.css is
  checked against its *opaque* surface, never against the blur.
- **It costs nothing.** Each `backdrop-filter` element forces the browser to
  render what is behind it to a texture, blur it and composite the result.
  Keeping it off the data-dense screens removes most of that work.

**Blur budget.** `--pg-blur` is 14px and `--pg-blur-strong` is 18px. Past
roughly 18px the look barely changes while the compositing cost keeps
climbing, so a larger radius is paid for and not seen.

**The specular rim.** Every material surface carries a 1px gradient border,
brightest where light would catch the top-left edge with a faint bounce along
the bottom, masked with `mask-composite: exclude` so only the border band
paints. It is what makes an edge read as a physical edge rather than a
stroke. It is a 1px band and content is inset by its padding, so the two
never overlap.

**Refraction is deliberately not attempted.** Apple's lensing is real-time
refraction of the pixels behind the material. On the web the only approximation
is an SVG `feDisplacementMap` referenced from `backdrop-filter`, which is
Chromium-only, cannot follow arbitrary shapes, and warps any text it covers.
Apple itself walked back lensing after it was criticised for exactly that
legibility cost. A frosted film that is correct everywhere beats a refraction
that works in one browser and damages reading in it.

**Fallbacks.** `@supports not (backdrop-filter)` makes the floating layer
opaque; `prefers-reduced-transparency: reduce` removes every film, blur and
bloom; `prefers-contrast: more` solidifies surfaces and strengthens borders;
`prefers-reduced-motion: reduce` removes transitions and press scaling.
Support for the transparency query is still uneven, which is precisely why it
only ever *removes* effects and never supplies contrast that was missing.

## 7. Space, layout, surfaces

4 px base. Site container 1340 px max, gutter `clamp(18px, 4vw, 44px)`, band padding
`clamp(56px, 9vw, 112px)`; the application content column is 1480 px.

The hero is one rounded, lit shell (`--pg-radius-shell`, 26 px) holding the chrome, the promise, a floating
sample stack and the property strip. From 1080 px the promise and the stack sit side by side as in the
reference; below that the promise leads and the stack follows it. Lifecycle: vertical below 1000 px, five
columns above. Capabilities are a one-pixel-gap grid, so the dividing lines are the layout.

Radius: controls and badges are fully pilled (`--pg-radius-control`), inputs 12 px, inner cards 14 px,
panels 18 px, dialogs 20 px, the shell 26 px. Elevation comes from the glass itself — an inset top
highlight plus a long, soft drop shadow (`--pg-shadow-panel`, `--pg-shadow-float`, `--pg-shadow-overlay`);
coral controls add `--pg-shadow-accent`.

**The property strip** is the recurring hairline motif: a single rule across the full width, cells below it
carrying an icon and two short lines, and a 2 px coral segment sitting on the rule above whichever cell is
active. It appears under the hero (`.hero-strip`) and over a run's figures in the application
(`.feature-strip`), where coral marks the figure holding the run up.

## 8. Motion

| Motion | Duration / easing | Purpose |
|---|---|---|
| Trace draws from the result to the selected stage on load | 1100 ms, `cubic-bezier(.2,.7,.2,1)`, once | Shows evidence flowing from a result |
| Trace and pulse move when a stage is selected | 420 ms, same easing | Connects the choice to the result |
| Evidence panel fades in | 220 ms | Reveals without layout animation |
| Hover colour | 160 ms | Feedback |

No loops, autoplay, parallax or scroll hijacking. Under `prefers-reduced-motion: reduce` every animation and
transition is removed and smooth scrolling is disabled; the full trace is visible on the first frame.

## 9. Interaction and accessibility rules

- Stages are buttons with `aria-expanded`/`aria-controls`; one is open at a time; all summaries are always visible.
- Skip link; sticky header with `scroll-padding-top` so anchored and focused content is not hidden (2.4.11).
- Focus: 2 px coral outline, offset 2–3 px. Coral reaches 6.6:1 on the canvas, so one focus colour works
  on every surface.
- Targets ≥ 44 px for primary controls, ≥ 24 px everywhere (2.5.8).
- Mobile menu: disclosure button, Escape closes it and returns focus, links close it.
- The footer service line reports only API reachability (checking / reachable / not responding / offline,
  with retry) and says that it does not verify payroll records or the audit chain.

## 10. Content rules

Every claim names behaviour that exists in the backend. Sample data is labelled in the card header and the
caption. Net pay is "before TDS" because PayGuard does not calculate TDS. Limits are stated next to the
integrity checks (tamper-evident, not tamper-proof; trusted chain starting point; no certification claimed).

## 11. The signed-in application

The application shares tokens, type and icon geometry with the site, with different priorities: stability,
density and speed over motion.

**Status vocabulary** (`components/ui/StatusBadge.jsx`). Each tone has its own colour, icon and words.

| Tone | Means | Never used for |
|---|---|---|
| verified | a check that ran and passed (chain verified, rule versions on file) | anything not actually checked |
| attention | action required (blocked employees, missing salary) | scope limits |
| failed | failed / error (failed run, broken chain) | warnings |
| deferred | deliberately out of scope (TDS, attendance): dashed, neutral | success or failure |
| unknown | not checked, unavailable or forbidden to this role | "verified" |

**Shell** (`components/PayGuardLayout.jsx`). The application sits on `.pg-canvas`, the same lit navy as the
site. A single glass bar holds the brand at the left, the permitted sections in a centred capsule
(`.pill-nav`, the current one in a lighter pill behind a coral point) and circular glass controls at the
right: the scope disclosure, the account menu and the sections drawer. The capsule appears from 1280 px; at
every width the drawer reaches all of them, takes focus, closes on Escape and cannot be reached while
closed. Below the capsule breakpoint the bar names the current section instead.

Which links appear is still decided by `can(user, permission)`; the shell grants nothing the API does not.
The scope limits ("income tax and attendance are not calculated") are stated twice: as a coral point on the
disclosure control, and as standing text in the shell footer on every screen.

**Overview.** Built only from API data, each source loaded independently so a forbidden or failed call
marks its own check "unavailable" instead of blanking the page. The failed run shows its recorded failure
reason and preflight blocking errors; zero counts carry a sentence saying why. Control checks derive from
real sources: payroll readiness (eligibility, salary versions, rule blockers), compliance rule versions,
audit-chain verification, and the two deferred areas. Chain verification, connectivity, data freshness
("figures loaded at"), payroll state and rule state are separate statements.

**Figures.** Schibsted Grotesk's tabular figures widen commas and points, so tabular numbers render in
IBM Plex Mono (`.tabular`, `.tabular-nums`). Clock times stay proportional.

**Layout.** Content max 1480 px; panels are frosted (§6a) at 18 px radius; tables scroll inside focusable,
positioned containers so they never widen the page; panels set `min-width: 0` to shrink inside grids.
Pages compose from the shared classes only — `.panel`, `.card-inset`, `.btn`, `.field`, `.status`,
`.data-table`, `.alert`, `.dialog`, `.feature-strip`. A screen that paints its own surface colour will
drift out of the system the next time the canvas changes, so inline colour is reserved for the one
property a control is varying (a text colour), never a background.
