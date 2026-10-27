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
| Display, headings, body | Schibsted Grotesk (variable), `@fontsource-variable/schibsted-grotesk@5.3.0` | SIL OFL 1.1 | Display 760, −0.048em, line-height 0.92; H2 720, −0.038em, 1.02; body 400, 1.55 |
| Evidence, metadata, amounts in tables | IBM Plex Mono 400/500, `@fontsource/ibm-plex-mono@5.3.0` | SIL OFL 1.1 | 11–13 px, uppercase labels +0.08–0.1em; values in sentence case |

Both are self-hosted (no third-party font request). The browser downloads only the subsets a page uses
(unicode-range); ₹ comes from the Latin-extended subset. Fallbacks: Segoe UI / system-ui and
Cascadia Mono / Consolas.

Fluid scale (`clamp`, 320–1440 px): display 3.5→6.5 rem; H2 2.125→3.75 rem; H3 1.1875→1.4375 rem;
lede 1.0625→1.3125 rem; body 1 rem; small 0.875 rem; meta 0.75 rem. Headings use `text-wrap: balance`,
paragraphs `pretty`. The big net-pay figure uses proportional figures (tabular figures widened the comma and
point); table amounts are monospaced so columns align.

## 6. Colour

One token file, `frontend/src/styles/tokens.css`, serves the public site and the signed-in application.
Tailwind reads the same values (`tailwind.config.js`), so `text-ink-2` and `var(--pg-ink-2)` are one colour.
Ratios are measured against porcelain unless noted.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `obsidian` | #10090D | sidebar, dark band, auth brand panel | porcelain on it 18.6:1 |
| `wine` | #650B1B | deep brand surface | white on it 13:1 |
| `crimson` | #C8102E | primary actions, links, red text | 5.6:1; white on it 5.9:1 |
| `crimson-strong` | #A50D26 | hover / pressed | — |
| `scarlet` | #FF2948 | the Proofline: lines, nodes, active-nav marker | 3.5:1, graphics only; 5.3:1 on obsidian |
| `porcelain` | #FBF8F6 | page | — |
| `surface` | #FFFFFF | panels | — |
| `ink` / `ink-2` | #171316 / #71666D | text / secondary text | 17.4:1 / 5.2:1 |
| `ink-3` | #8E8389 | placeholders and disabled only | — |
| `line` / `line-strong` | #E8DDE0 / #CDBFC4 | separators / button outlines | decorative |
| `field` | #9C8F95 | input borders | 3.1:1 on white |
| `ok` | #167A3E | verified / resolved | 5.4:1 on white |
| `warn` | #8A5300 | action required | 5.8:1 on its tint |
| `bad` | #A3132A | failed / error | 6.9:1 on its tint |
| `defer` | #5E585C | deferred / out of scope | 6.1:1 on its tint |

Red is used for connection and action only. Status is never colour-alone: every status carries text and an
icon (see §11).

## 7. Space, layout, surfaces

4 px base. Container 1320 px max, gutter `clamp(16px, 4vw, 48px)`, section padding
`clamp(72px, 10vw, 144px)`. Hero is two columns from 1140 px (copy sticky beside the evidence), one column
below. Lifecycle: vertical below 640 px, label/body rows 640–999 px, five columns from 1000 px.
Capabilities are an editorial index (rules, not cards). Radius: 10 px controls, 16 px surfaces, 12 px inner
panels. Only the evidence card has elevation; everything else is separated by rules.

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
- Focus: 2 px crimson outline, offset 3 px (signal-on-ink on the dark band).
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

**Shell** (`components/PayGuardLayout.jsx`). An obsidian rail (248 px, collapsible to 76 px with tooltips,
remembered per browser) with a 2 px scarlet marker on the active item; below 1024 px the same nav element
becomes a drawer that takes focus, closes on Escape and cannot be reached while closed. The top bar holds
the section name, an explained scope note ("TDS and attendance deferred") and an account menu.

**Overview.** Built only from API data, each source loaded independently so a forbidden or failed call
marks its own check "unavailable" instead of blanking the page. The failed run shows its recorded failure
reason and preflight blocking errors; zero counts carry a sentence saying why. Control checks derive from
real sources: payroll readiness (eligibility, salary versions, rule blockers), compliance rule versions,
audit-chain verification, and the two deferred areas. Chain verification, connectivity, data freshness
("figures loaded at"), payroll state and rule state are separate statements.

**Figures.** Schibsted Grotesk's tabular figures widen commas and points, so tabular numbers render in
IBM Plex Mono (`.tabular`, `.tabular-nums`). Clock times stay proportional.

**Layout.** Content max 1400 px; panels 14 px radius, 1 px line border, no decorative shadow; tables scroll
inside focusable, positioned containers so they never widen the page; panels set `min-width: 0` to shrink
inside grids.
