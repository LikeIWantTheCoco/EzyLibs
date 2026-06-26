# image

Image processing for Ezy. Load **PNG / JPG / BMP / GIF / TGA / PSD / HDR**
(via embedded stb_image), save **PNG / JPG / BMP**, and manipulate: resize,
crop, rotate/flip, colour adjust, filters, compositing, shapes, and TTF text.

Self-contained: stb_image (decode) is embedded; PNG/BMP encoders are built in;
JPEG save uses libjpeg and text uses freetype. Images are RGBA8 referenced by a
handle, wrapped in an `Image` class.

## Install

```bash
ezyl install ./image
```

Links libjpeg + freetype (pulled in by the manifest). Default text font is
DejaVuSans; override with `set_font("/path/to.ttf")`.

## Quick start

```ezy
import "image"

fn main():
{
    im = load("photo.jpg")
    print(im.width(), im.height())

    thumb = im.thumbnail(256)        # keeps aspect ratio → new Image
    thumb.grayscale()                # in place
    thumb.text(8, 8, "© Ezy", 20, 255, 255, 255)
    thumb.save("thumb.png")          # format from the extension
}
```

## API (`Image`)

`load(path)` / `new_image(w, h, r=0, g=0, b=0, a=255)` → an `Image`.

| Group | Methods |
|-------|---------|
| info / io | `ok()` `width()` `height()` `save(path)` `save_jpg(path, q)` `free()` |
| transform → **new Image** | `clone()` `resize(w,h)` `thumbnail(max)` `crop(x,y,w,h)` `rotate90(times)` `flip_h()` `flip_v()` |
| colour (in place) | `brightness(d)` `contrast(f)` `saturation(f)` `gamma(g)` `grayscale()` `invert()` |
| filters (in place) | `blur(radius)` `sharpen()` `edges()` |
| compose / draw (in place) | `overlay(top, x, y, opacity)` `fill(r,g,b,a)` `set_pixel(x,y,r,g,b,a)` `pixel(x,y)` `rect(...)` `line(...)` `circle(...)` `text(x,y,str,size,r,g,b)` |

Free functions: `img_format(path)`, `img_filesize(path)`, `set_font(path)`,
`version()`, plus the flat `img_*` entry points the class wraps.

### Metadata (header only — no full decode)

`img_probe(path)` → `"WxH, N channels, fmt"`, plus `img_probe_width(path)`,
`img_probe_height(path)`, `img_probe_channels(path)` (1=gray, 3=RGB, 4=RGBA, as
stored), `img_is_hdr(path)`. These read just the file header.
Note: pixel **EXIF** (camera/GPS/etc.) is *not* parsed — only dimensional /
structural metadata.

## Supported formats

| | Formats |
|---|---|
| **Decode** (`load`, `probe`) | JPEG, PNG, BMP, GIF (first frame), TGA, PSD, HDR, PIC, PNM (PPM/PGM) |
| **Encode** (`save`, `save_jpg`) | PNG, BMP, JPEG |

> **Note:** transform methods return a **new** `Image`; colour/filter/draw
> methods mutate the receiver in place. Assign returned images to a variable
> (`t = im.thumbnail(256)`) — Ezy can't chain a method on a returned object.

## Notes

- Coordinates are pixels, origin top-left. Colours are `r,g,b` 0–255 with an
  `a` alpha; drawing/overlay alpha-blend onto the target.
- `pixel(x,y)` returns a packed `0xRRGGBBAA` int.
- `save(path)` picks the encoder from the file extension (`.png`/`.jpg`/`.bmp`),
  defaulting to PNG.
