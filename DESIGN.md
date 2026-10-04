# Design

One ground and one accent per appearance, one mark, and the files that define
them. Both grounds are neutral; the deep blue supplied with the logo belongs to
the app icon. The light appearance is the dark one's sibling, not a tint of it.
If a second colour starts carrying interface meaning, it belongs in this
document or it does not belong in the app.

## Dark palette and Proof Blue

| Token | Value | Use |
| --- | --- | --- |
| Ground | `#1e1e1f` | Window and editor in the dark appearance |
| Icon tile | `#0c1622` | App-icon ground (`assets/icon-manifest.json`) only |
| Accent | `#6ea1ff` | Caret, focus, active formatting, links |
| Positive | `#76c392` | Connected, saved, available, and Verified state |
| Positive text | `#9bd5ae` | Positive status copy on the ground |
| Caution | `#d7a13a` | Pending, saving, incomplete, and attention state |
| Caution text | `#e3c486` | Caution status copy on the ground |
| Negative | `#d66b63` | Error, failed, destructive, and offline state |
| Negative text | `#f0aaa4` | Negative status copy on the ground |

These are defined in [`app/src/styles.css`](app/src/styles.css). Interface code should use the tokens; the
only literal colour outside them is white text on a person's presence colour. The light palette
is written twice there, for Auto and for pinned Light, and `theme-palette.test.ts` keeps the two
copies identical and in step with the dark token set.

## Light palette

Settings offers Auto, Light, and Dark, and Auto is the default. Dark is the table above; Light is a
sibling palette selected by `prefers-color-scheme` under Auto or by `data-theme="light"`. It keeps
slightly cool neutrals and darkens the accent and status hues so they hold contrast on a pale
ground. The app icon keeps its deep-blue tile in both.

| Token | Value |
| --- | --- |
| Ground | `#f7f9fc` |
| Accent | `#2a66d9` |
| Positive / text | `#2f8a57` / `#236b43` |
| Caution / text | `#b57d12` / `#845906` |
| Negative / text | `#c4473e` / `#9e2f28` |

The rest of the palette in that file, including `--ink`, `--ink-soft`,
`--ink-faint`, `--rule`, and `--raised`, is the neutral ramp. The greys are
neutral in dark and carry a slight cool bias in light.

The six `--status-*` variables are the non-accent semantic palette. They report
outcomes and lifecycle state whose meaning is also present in text, structure,
or an icon. They never indicate selection, focus, links, or actor identity.

### What the accent is for

The one saturated thing in a view: the caret, a focused control, a link. If two
things in the same view are blue, one of them is wrong.

Presence colours are not the accent. Actors are assigned from a separate
six-colour palette in [`app/src/names.ts`](app/src/names.ts), because a person
in the document is not a piece of interface chrome, and their colour has to stay
theirs across both themes.

## The mark

Two quotation forms face inward. They make thought and authorship literal
without adding a wordmark to small app surfaces. The icon uses the white mark
on the deep-blue tile; standalone blue and white SVG variants support light and
dark external grounds.

The supplied master files live in [`assets/orbit/`](assets/orbit/),
[`assets/macos/`](assets/macos/), and [`assets/web/`](assets/web/).
[`assets/icon-manifest.json`](assets/icon-manifest.json) carries the shared
ground into generated platform assets. See [`assets/README.md`](assets/README.md)
for the regeneration path.
