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

- Downscaled so the longest edge is at most 96 px, then resampled to **72 px**
  for the shipped strip (the final bullet below).
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
- Inset every frame, then padded every canvas out to a uniform **96×96** with
  transparency. Both steps matter to the strip: the inset keeps the artwork off
  the cell edges, and the uniform canvas keeps the poses the same width. The
  strip derives a pose's cell width from its PNG header, so a 77 px canvas
  displayed as 7 columns while a 96 px one displayed as 8, and the two states
  ended up centred a column apart. This is an **intermediate** canvas, not the
  shipped one: the frames are later resampled to 72 px (below), where the inset
  scales to ~4 px.
- Shifted the idle frames 2 px right so their artwork is centred. The upstream
  idle poses are *left*-aligned (every frame's alpha starts at the same column)
  while the working poses are centred, so centring the union of the idle frames
  still left each individual pose — and the dominant awake pose above all — off
  to the left. The shift is uniform across the state, so the animation cannot
  wobble. (Also applied on the intermediate 96 px canvas.)
- Resampled 96×96 → **72×72** and reduced to a **256-colour indexed palette with
  a `tRNS` alpha table**. The terminal displays a frame at 8×4 cells — ≈72×72 px
  when the terminal reports cells of 9×18 — so the extra resolution was being
  downscaled away; the palette cuts the payload 131,442 → 33,308 B (−75 %). This
  is the **only lossy step**. Measured against the 96 px source (`dd048d1`)
  area-averaged to 72 px, the shipped frames differ by **4.5 % premultiplied
  RGBA RMSE** on average (worst frame 4.8 %, ≈27 dB PSNR); `npm run fidelity`
  reproduces the figure. That metric bounds the resample *and* the palette
  together, and the error is concentrated on soft edges and low-alpha pixels
  rather than on flat fills.

No frame was redrawn or composited; the only lossy change is the resample and
palette quantisation above.

## Regenerating the strip

The 96 px canvas frames are the pre-quantisation source; they are not checked
out at HEAD but live in git history at commit `dd048d1`. From that revision the
shipped frames are an ImageMagick resample plus palette reduction:

```sh
magick 96/idle-awake.png -resize 72x72 -colors 256 -strip png8:idle-awake.png
```

The palette ImageMagick chooses — and therefore the exact bytes — depends on the
build and version (the shipped frames came off an ImageMagick 7.x tree), so this
reproduces an **equivalent** strip, not a bit-identical one. `npm run fidelity`
reports how far any regeneration drifts from what is committed.

## Why not the upstream preview GIFs

The documentation GIFs (`docs/*-preview.gif`) are rendered on a light-blue
background, so their frames are fully opaque — measured `opaque: True` with a
corner pixel of `rgb(220,236,247)`. They are not usable as a source for an image
that must sit on an arbitrary terminal background.

## Not covered here

The whale-chan *character* is a community fan creation whose design credits
belong to the community, covered by the "Credits & Attribution" section of
[README.md](README.md). The persona text is unrelated to this attribution.
