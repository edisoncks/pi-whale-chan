# Whale-chan pet artwork attribution

The animated pet strip (`assets/whale-pet/`) is derived from
[`dsh-whale-pet`](https://github.com/Er1c0v0/dsh-whale-pet) by **Er1c0v0**,
used under the
[Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/).

The upstream project splits its licensing: **code** is MIT, **artwork** is
CC-BY-4.0. Only the artwork is used here.

## What was taken

| In this extension | Upstream source | Upstream license |
|---|---|---|
| `assets/whale-pet/idle-*.png` | `character/idle_pillow_*.png` | CC-BY-4.0 |
| `assets/whale-pet/working-*.png` | `character/working_*.png`, via the published `dsh-whale-pet@0.1.0` build (which applies the upstream background removal) | CC-BY-4.0 |
| Frame order and per-frame timing in `pet.ts` | `src/client/idle-animation.json`, `src/client/assets.ts` | MIT (code) |

Upstream authorship, as recorded in that repository's own `ASSET_ATTRIBUTION.md`:

> Creator and copyright holder: **Er1c0v0** (repository owner). Origin: original
> artwork generated personally by the creator for this project … generated as
> identity-preserving derivatives with OpenAI's built-in image generation tool.
> First public source:
> `https://github.com/Er1c0v0/dsh-whale-pet/tree/main/character`.

## Modifications

Every frame was mechanically modified for terminal display:

- Downscaled so the longest edge is at most 96 px.
- Cropped each state's frames to the **union** of their alpha bounding boxes, so
  frames stay aligned to one another and the animation cannot jitter. No frame is
  re-anchored individually — the poses are the artist's acting, and flattening
  them would remove it.
- Idle frames only: removed the upstream white background by flood-filling from
  the four corners (16 % fuzz), then eroding the alpha matte by one pixel at full
  resolution before downscaling. The working frames came from the upstream
  *generated* WebP, which already carries an alpha channel.
- Re-encoded as PNG, because Pi's terminal layer transmits PNG (`f=100`) and has
  no payload type for WebP.
- Inset every frame by 6 px per side, then padded every canvas out to a uniform
  **96×96** with transparency. Both steps matter to the strip: the 6 px inset
  keeps the artwork off the cell edges, and the uniform canvas keeps the poses
  the same width. The strip derives a pose's cell width from its PNG header, so
  a 77 px canvas displayed as 7 columns while a 96 px one displayed as 8, and
  the two states ended up centred a column apart.
- Shifted the idle frames 2 px right so their artwork is centred. The upstream
  idle poses are *left*-aligned (every frame's alpha starts at the same column)
  while the working poses are centred, so centring the union of the idle frames
  still left each individual pose — and the dominant awake pose above all — off
  to the left. The shift is uniform across the state, so the animation cannot
  wobble.

No frame was redrawn, recoloured, or composited.

## Why not the upstream preview GIFs

The documentation GIFs (`docs/*-preview.gif`) are rendered on a light-blue
background, so their frames are fully opaque — measured `opaque: True` with a
corner pixel of `rgb(220,236,247)`. They are not usable as a source for an image
that must sit on an arbitrary terminal background.

## Not covered here

The whale-chan *character* is a community fan creation whose design credits
belong to the community, covered by the "Credits & Attribution" section of
[README.md](README.md). The persona text is unrelated to this attribution.
