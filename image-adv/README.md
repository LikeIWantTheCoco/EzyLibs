# image-adv

Advanced extras for the [`image`](../image) library: **image comparison /
change detection** and **OCR**.

This is an **extension library** — its manifest sets `"extends": "image"`, so
ezyl compiles `image.c` and `image_adv.c` together into one `.so`, and
`import "image-adv"` pulls in the whole `image` API *plus* the extras below.
The base `image` library stays lean; the heavier/optional pieces live here.

## Install

```bash
ezyl install ./image        # base (required)
ezyl install ./image-adv    # extension — recompiles image in alongside it
```

OCR uses the **tesseract** CLI (`tesseract` on PATH; install `tesseract-ocr`
and the language data you need, e.g. `eng`, `spa`). `ocr_available()` reports it.

## Use

```ezy
import "image-adv"               # gives the full image API + these extras

fn main():
{
    a = load("before.png")
    b = load("after.png")

    print(compare(a, b))             # 0.0 identical … 1.0
    print(changed_pct(a, b, 25))     # % of pixels changed beyond a threshold
    diff(a, b).save("changes.png")   # red = changed, gray = unchanged

    doc = load("scan.png")
    print(ocr(doc, "eng"))           # extract text
}
```

## API

| Comparison | |
|---|---|
| `compare(a, b)` | mean difference, 0.0 (identical) … 1.0 (−1 if sizes differ) |
| `equal(a, b)` | `true` if pixel-identical |
| `changed_pct(a, b, threshold=25)` | % of pixels changed beyond `threshold` (0–255) |
| `diff(a, b)` → `Image` | changed pixels in red over a dimmed grayscale base |

| OCR | |
|---|---|
| `ocr(image, lang="eng")` | extract text from a loaded `Image` |
| `ocr_file(path, lang="eng")` | extract text straight from a file |
| `ocr_available()` | `true` if tesseract is installed |

`a`, `b`, `image` are `Image` objects from the base library. `lang` accepts
tesseract codes and combinations (`"eng"`, `"spa"`, `"eng+spa"`).
