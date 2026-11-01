# dsh-watch-browser

Drive a real browser window from DSH so the agent can put content on screen and
then check its own senses: open a page, start a video, confirm it is playing.

## Why it is built this way

- **It reuses the installed Edge** (channel list: config, msedge, chrome, then a
  bundled Chromium) so nothing has to be downloaded on a machine that already
  has a browser.
- **A persistent profile** keeps logins between runs; cookies survive a restart.
- **Autoplay is forced on** (--autoplay-policy=no-user-gesture-required);
  without it a script-opened video stays silent, and a silent video cannot be
  used to test hearing.
- **Two tools only**, so the schema cost on every request stays small: one
  dispatcher and one state reader.

## Layout

    lib/daemon.mjs    owns the persistent context, loopback HTTP on 127.0.0.1:37713
    lib/client.mjs    ensure-daemon + call helpers
    lib/index.js      cordis plugin: browser_do / browser_state
    bin/browser.mjs   the same pipeline as a CLI

## Config

    ~/.dsh-watch-browser/config.json

    channel     default "msedge"
    headless    default false
    accounts    per-site credentials, never logged

## Actions

    goto click fill press eval wait back reload screenshot
    play pause seek mute volume
    login-bilibili

The first <video> element on the page is the target, so play/pause/seek work on
almost any player without selectors.

## CLI

    browser goto <url>
    browser play | pause
    browser do screenshot
    browser state
    browser set-account bilibili <user> <password>

## Known limits

- A site that guards login with a captcha or slider cannot be automated past it;
  login-bilibili reports honestly whether a session cookie appeared.
- Screenshots go to ~/.dsh-watch-browser/shots/.
