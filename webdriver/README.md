# webdriver

Browser automation for Ezy. Two engines, **one API**:

- **Chromium / Chrome / Brave / Edge** → Chrome DevTools Protocol (CDP)
- **Firefox / Gecko** → WebDriver BiDi

Self-contained C — no external deps. Launches the browser with its remote
debugging port, opens the debugging **WebSocket** (hand-rolled client), and
drives it (CDP for Chromium, BiDi for Firefox; both are JSON-RPC over WS, so the
core is shared). Element work is injected JavaScript; real mouse/keyboard input
goes through the protocol's input domain, so pages see genuine events.

## Install

```bash
ezyl install ./webdriver
```

Needs a supported browser on `PATH`. Override the binary with
`EZY_CHROME=/usr/bin/brave-browser` or `EZY_FIREFOX=/usr/bin/firefox`.

## Quick start

```ezy
import "webdriver"

fn main():
{
    b = chrome()                       # or firefox(); pass 1 for headless
    b.anti_detection()                 # hide automation + spoof fingerprints
    b.goto("https://example.com")
    print(b.text("h1"))
    b.human_click("#login")            # curved-mouse, human-timed click
    b.human_type("#user", "ezy")       # paced typing
    b.screenshot("page.png")
    b.close()
}
```

## API (OOP)

`chrome(headless=0, w=1280, h=800)` / `chrome_profile(profile, headless=0)` /
`firefox(headless=0, w=1280, h=800)` → a `Browser`. `b.find(sel)` /
`b.nth(sel,i)` → an `Element`. The whole API below is identical across engines.

| Browser | |
|---------|---|
| `goto(url)` `back()` `forward()` `refresh()` | navigation (`goto`, not `go` — reserved) |
| `current_url()` `title()` `html()` `screenshot(path)` | page info / capture (PNG) |
| `find(sel)` `nth(sel,i)` `count(sel)` `exists(sel)` `find_text(t)` | selection |
| `text(sel)` `click(sel)` `write(sel,t)` `attr(sel,name)` `clear(sel)` `is_visible(sel)` `is_enabled(sel)` | selector shortcuts (no chaining) |
| `wait_for(sel,ms)` `wait_for_not(sel,ms)` `wait_for_text(sel,t,ms)` `wait_for_page(ms)` | smart waits |
| `eval(js)` | run JS, get the value back as a string |
| `anti_detection()` `hide_automation()` `spoof_webgl/canvas/audio()` `set_user_agent(ua)` `set_viewport(w,h)` `set_timezone(tz)` | anti-detection |
| `human_click(sel)` `human_type(sel,t)` `random_scroll()` `random_delay(a,b)` | human behaviour |
| `cookies()` `set_cookie(n,v)` `delete_cookie(n)` `clear_cookies()` | cookies |
| `maximize()` `close()` | window / lifecycle |

| Element (`e = b.find(sel)`) | |
|------|---|
| `click()` `human_click()` `write(t)` `human_write(t)` `clear()` | actions (`write`, not `type` — reserved) |
| `text()` `html()` `attr(name)` `exists()` `is_visible()` `is_enabled()` | reads |
| `find(sub)` | descendant selector |

> **Note:** Ezy can't call a method on a value returned by another call
> (`b.find(x).text()` misbehaves). Either assign first
> (`e = b.find(x); e.text()`) or use the `Browser` selector shortcuts
> (`b.text(x)`), which is the recommended style.

## Anti-detection / human behaviour

`anti_detection()` installs page scripts (via
`Page.addScriptToEvaluateOnNewDocument`) that make `navigator.webdriver`
`undefined`, fake plugins/languages, and spoof WebGL / Canvas / AudioContext
fingerprints. `human_click` moves a virtual cursor along a randomized **Bézier
curve** with eased speed and jitter (same idea as the `autogui` lib) before a
human-length press; `human_type` paces keystrokes with variable, punctuation-
aware delays and occasional hesitations.
