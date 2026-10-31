# Modelizer Design System

## 1. Atmosphere & Identity

Modelizer is a quiet local operations dashboard: provider identity stays prominent, quota state reads quickly, and secondary usage detail stays folded until needed. Its signature is restrained data hierarchy on neutral surfaces, not decoration.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---|---|---|
| Page | `--bg` | `#ffffff` | Page canvas and quiet status fills |
| Card | `--card` | `#ffffff` | Provider cards and panels |
| Primary text | `--text` | `#1a1d23` | Main labels and values |
| Secondary text | `--muted` | `#6b7280` | Supporting information |
| Divider | `--border` | `#e3e6ea` | Card edges and row separation |
| Accent | `--accent` | `#2563eb` | Quota emphasis and links |
| Accent wash | `--accent-soft` | `#eff4ff` | Quota labels |
| Success | `--good` | `#15803d` | Healthy status |
| Success wash | `--good-soft` | `#ecfdf3` | Success background |
| Warning | `--warn` | `#b45309` | Warning status |
| Error | `--bad` | `#dc2626` | Errors |

Use the existing semantic tokens. Do not introduce a provider-specific color or use color alone to communicate status.
The product is light-only: `color-scheme: light` keeps the page white regardless of the operating system's theme. A user-controlled dark theme would be a separate feature.

## 3. Typography

The interface uses the system sans-serif stack: `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `Roboto`, sans-serif. Monospaced tabular numerals are used for countdowns and measured values.

| Role | Size | Weight | Usage |
|---|---:|---:|---|
| Page title | 22px | 600 | App name |
| Provider title | 19px | 400 | Card identity |
| Body | 14px desktop / 15px phone | 400 | Quota usage and reset values |
| Supporting | 13px | 400 | Existing secondary card information |
| Compact label | 12px desktop / 13px phone | 400–600 | Window labels and metadata |
| Badge | 11px | 600 | Stability tier |

## 4. Spacing & Layout

The existing spacing rhythm uses 4px as its base, with common steps at 4, 6, 8, 10, 12, 14, 16, 18, and 24px. The page is centered and capped at 600px; the provider list remains one card wide. Cards use 16px vertical and 18px horizontal padding with a 16px inter-card gap.

Each provider card is a vertical stack: provider header, visible quota summary, then expandable details. A quota summary is a two-column switcher: window usage on the left and its next reset on the right. At viewport widths below 480px, those regions stack in reading order. The document owns vertical scrolling; the card introduces no nested scroll region.

The five-tab navigation stays on one line: its spacing tightens below 480px and its compact text scale applies below 360px. Cards can shrink with the page track; below 480px, the card header may wrap badges rather than forcing provider names to wrap or causing horizontal scrolling.

## 5. Components

### Provider card
- **Structure:** Provider identity and controls, quota summaries, expandable status and usage details.
- **Variants:** Metered provider, plan-only provider, provider with no quota data.
- **States:** Collapsed, expanded, healthy, degraded, hidden.
- **Accessibility:** Provider title is a named button; hide controls retain their provider-specific accessible names.
- **Layout:** Vertical stack; document scrolls.

### Quota window row
- **Structure:** Window label and usage at the leading side; provider-reported reset countdown and local day/time at the trailing side.
- **Variants:** Five-hour, weekly, and provider-specific fallback windows.
- **States:** Reset available, idle with no reset to wait for, reset time not reported, stale data.
- **Accessibility:** Keep label, usage, and reset in the DOM reading order; do not rely on color or tooltip text to expose the reset.
- **Layout:** Two-column switcher above 480px; stacked below.

### Provider mark and status badge
- **Structure:** Provider image or letter fallback beside the name; textual health and stability badges.
- **Variants:** Image mark or fallback tile; good, warning, error, and muted status.
- **Accessibility:** Provider name remains text; status remains textual in addition to color.

## 6. Motion & Interaction

The provider disclosure chevron rotates over 120ms. No new motion is introduced for quota layout or countdown updates. Under `prefers-reduced-motion: reduce`, the chevron transition is disabled.

## 7. Depth & Surface

Use the existing borders-only separation: a 1px semantic border, card background, and 12px card radius. Do not add shadows or decorative card effects.

## 8. Accessibility Constraints & Accepted Debt

Maintain a readable source order at all widths, visible keyboard focus on controls, textual status, the light color scheme, and tabular countdown digits. Reset time is shown only when `reset_at` is supplied by the provider; idle and unreported reset cases remain distinct.
At phone widths, navigation tabs, card toggles, hide controls, and restore chips expose 44px interaction targets while keeping the close glyph visually compact.

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| No new accessibility debt accepted | This change | Existing compact labels outside the quota summary are not being redesigned | Reassess in a broader dashboard accessibility pass |
