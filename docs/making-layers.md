# Making layers

The player is the easy half. The pictures are the craft: every layer has to
hide the next one in its centre so cleanly that nobody sees where one ends and
the next begins. This page covers the rules and a workflow that works with any
image model, a camera, or a paintbrush.

## The rules

1. **Same shape, large.** Every layer has the same aspect ratio (16:9 suits
   most screens) and is at least 2560 px wide. 3200 to 3840 px looks sharp on
   large and high-density screens.
2. **The middle quarter is the next layer.** With the default `scale` of 4,
   the rectangle at the centre of layer i, a quarter of its width and a
   quarter of its height, shows the whole of layer i+1. The player draws
   layer i+1 over exactly that rectangle.
3. **Only the border has to match.** The inner layer is drawn on top, with its
   edges faded over the outer 6% of its frame. So what matters is that the
   band around the edge of layer i+1 looks like the matching part of layer i.
   The middle of layer i's centre rectangle can be rough, because it is always
   covered.
4. **The last layer hides the first.** That closes the loop. Two ways that
   work:
   - Organic: the last scene naturally contains the first. A bubble holds a
     galaxy that turns out to be the opening planet (`examples/space`).
   - Picture: the last scene shows the opening shot on a screen, a print or a
     window (`examples/yepedu`, where it is a tablet).
5. **Pick centres you can dive into.** A page, a screen, a window, a drop of
   water, a bubble, an eye. Each one is a frame inside the frame, so the next
   scene has a reason to be in there.

## A workflow that works

Make the layers outside in, one at a time:

1. Make layer 0, with the subject of layer 1 in its exact centre.
2. Crop the centre quarter of layer 0 and enlarge it four times. This blurry
   crop is the reference for layer 1: its outer band is what layer 1's border
   has to match.
3. Generate layer 1 from that reference. With an image model, give it the
   reference image and ask it to keep the outer band (shapes, colours and light
   in the same places) and to paint the new scene sharply in the middle, with
   the subject of layer 2 at its centre. Blurring or smearing the middle of
   the reference first helps the model let go of it.
4. Check the seam, then repeat for the next layer.

Check as you go, not at the end, because each layer inherits the border of the
one before it:

```
python build.py check examples/mydive
```

It compares each layer's border band with the centre of the layer around it.
Single digits are invisible in motion. Ten to fifteen shows up if you look
for it. Above fifteen is a visible seam: regenerate that layer, or fix its
border in an image editor, before you make the next one.

## What goes wrong

| You see | Try |
|---|---|
| The model redraws the reference instead of a new scene | Smear the middle of the reference harder, and describe the centre subject concretely |
| A horizon or hard line runs down every layer | Ask for a soft gradient where it meets the border |
| Text or numbers ghost near the edge | Keep lettering out of the outer tenth of the frame |
| A layer comes back lighter, darker or tinted | Ask for neutral light, or match its colours to the reference before the next step |
| The closing picture comes back washed out | Paste the real first layer into the last layer's centre yourself |

## Video

A layer can also play a short silent loop while it rests (`video` in
[dive.json](dive-json.md)). The still image is still needed, because the zoom
itself uses it.
