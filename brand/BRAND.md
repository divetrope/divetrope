# Divetrope brand

## Name

Divetrope: *dive* plus *trope*, from the Greek *tropos*, a turn. It is also
the storyteller's word for a familiar device, and the picture inside a
picture is one of the oldest. Write it as one word with a capital D in
prose, and in lower case (`divetrope`) in code, URLs and package names.
Never "DiveTrope" or "Dive Trope".

## Mark

`mark.svg`: three frames, each smaller than the one around it and turned a
little further, with a warm light at the centre. It is the product in one
picture: a frame inside a frame inside a frame, turning as you dive in.

- Keep the dark tile behind it. On a dark page, the tile can sit flush.
- At 16 px the mark still reads as nested frames; below that, use the tile alone.
- Don't recolour the frames, add shadows, or animate the mark without its centre light.

## Colour

| Name | Hex | Use |
|---|---|---|
| Night | `#0b1020` | Backgrounds, the tile, text on light |
| Signal | `#4c6fff` | Primary buttons, links, the outer frame |
| Signal deep | `#3651d9` | Hover and pressed states |
| Haze | `#8fa2ff` | The middle frame, secondary accents |
| Lamp | `#ffb547` | The centre light, highlights, the current scene |
| Paper | `#f6f7f4` | Text on dark |

These are also the player's default theme (`--dt-*` in `divetrope.js`).

## Type

- Display: Bricolage Grotesque, weight 600.
- Text: Inter, 400 to 600.

Both are on Google Fonts under the SIL Open Font License.

## Voice

Plain and visual. Say what the reader will see and do: "Scroll into the
picture", not "immersive storytelling experiences". Short sentences, no
hype, and no claims the code doesn't back up.

- Tagline: **Scroll into the picture.**
- One line: An open-source web component for endless-zoom stories.
- One paragraph: Each scene hides the next one in its centre, and the last
  one hides the first. Readers scroll, drag or press Play to dive through
  them.

## Files

| File | |
|---|---|
| `mark.svg` | The mark on its tile |
| `hero.webp` | The README animation (animated WebP, 720 px) |
| `social-preview.png` | 1280 x 640, for the GitHub repository's social preview setting |
