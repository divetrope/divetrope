# dive.json

A dive is a folder with a `dive.json`, its layer images, and an optional
`assets/` folder (logo, video clips) that is copied into the built site as is.
`python build.py <folder>` turns it into a static site; the site's
`manifest.json` is the same document with the image paths replaced by the
exported sizes.

Start one with `python build.py new <folder>`, or copy `examples/yepedu`.

## Top level

| Key | Default | |
|---|---|---|
| `scale` | `4` | How much smaller each layer is than the one around it. 4 means layer i+1 fills the middle quarter of layer i's width and height. |
| `width`, `height` | first image's size | Canvas size. Images with another shape are centre-cropped to it, then resized. |
| `export_sizes` | `[3200, 2400, 1600]` | Widths written for each layer. The player picks one for the screen it is on. Sizes larger than `width` are skipped. |
| `brand` | none | The bar across the top in page mode, or when `chrome="full"`. |
| `page` | `{}` | Title, intro, end card, looping. |
| `theme` | engine defaults | Colours and fonts. |
| `score` | built in | The music that plays with Play. |
| `layers` | required | Outermost first. At least two. |

## layers[]

| Key | |
|---|---|
| `id` | Short name, used in file names. Letters, digits and dashes. |
| `image` | Path to the image, relative to the folder. Any format Pillow reads. |
| `label` | Shown on the dot for this scene. Defaults to `id`. |
| `alt` | What the picture shows, in one sentence, for screen readers. The player reads it out as each scene arrives. Without it, readers who can't see the canvas hear only the `label`. |
| `eyebrow` | Two to four words above the headline. |
| `headline` | The line shown while the story plays. Keep it under about eight words so it reads in motion. |
| `body` | One or two sentences, shown when the reader pauses or presses More. |
| `chips` | A few short tags under the body. |
| `hold` | Seconds Play lingers on this scene, 5.5 by default. |
| `video` | A short silent loop that plays while the scene rests. Optional. Put the file in `assets/` and give its path relative to `assets/`, such as `clips/kitchen.mp4`. |

A layer with no copy is a pure picture: the headline hides while it is on
screen.

## brand

```json
"brand": {
  "name": "Your brand",
  "url": "https://example.com/",
  "logo": "logo.svg",
  "badge": "Beta",
  "cta": "Get started",
  "ctaHref": "https://example.com/start"
}
```

`logo` is a file in `assets/`. The bar's button appears when both `cta` and
`url` are set; it links to `ctaHref` if given, otherwise to `url`.

## page

| Key | |
|---|---|
| `title`, `description`, `lang` | The page's `<title>`, meta description and language. |
| `loop` | `true` wraps the dive forever (the last layer leads back into the first). `false` ends on the end card. |
| `intro` | The opening screen: `eyebrow`, `title`, `sub`, `play` (button text), `alt` (hint under it in page and scroll modes), `altPlayer` (hint in player mode). `false` skips it. |
| `end` | The end card when `loop` is false: `eyebrow`, `headline`, `body`, `primary` and `secondary` (`{label, href}`), and `rail` (the last dot's label). |
| `loading` | Text under the loading bar. |
| `ui` | Overrides for the built-in button labels, for other languages: `play`, `pause`, `more`, `less`, `replay`, `start`, `soundOn`, `soundOff`, `fullscreen`, `exitFullscreen`, `end`, `dragHint`, `loading`, `error`. |

## theme

| Key | CSS variable |
|---|---|
| `ink` | `--dt-ink`: background, and the tint behind text |
| `primary`, `primaryDeep` | `--dt-primary`, `--dt-primary-deep`: buttons and their hover |
| `accent` | `--dt-accent`: highlights, the current dot, the eyebrow |
| `onDark`, `onDarkDim` | `--dt-on-dark`, `--dt-on-dark-dim`: text |
| `chips` | `--dt-chip-1` to `--dt-chip-3` |
| `fontDisplay`, `fontText` | `--dt-font-display`, `--dt-font-text` |
| `fontsHref` | A stylesheet that loads the fonts. A relative path such as `fonts/fonts.css` is read from the dive's `assets/` and resolves against the manifest, so embeds on other sites find it too. |

Prefer self-hosted fonts to a Google Fonts link. A remote font service sees
every visitor's IP address, and German courts have held that this needs the
visitor's consent under the GDPR. The examples ship their fonts in
`assets/fonts/` with each family's license next to the files.

A host page can override any `--dt-*` variable on the element itself, plus
`--dt-radius` (rounds the player's corners) and `--dt-top` (moves the pinned
section below a fixed site header):

```css
divetrope-player { --dt-radius: 16px; --dt-top: 64px; }
```

## score

Play starts a score synthesized live with Web Audio, so there are no audio
files to host. Each scene changes the chord; the end card resolves home.

| Key | |
|---|---|
| `chords` | A list of chords as MIDI note numbers, one per scene, cycled. |
| `home` | The final chord. |
| `sparkle` | The scene index that gets a shower of bells. |
| `bpm`, `level` | Tempo and loudness. |
