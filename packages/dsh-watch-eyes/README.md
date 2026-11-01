# dsh-watch-eyes

Live screen eyes for text-only DSH models: a resident capture worker plus a
direct vision call, so one frame costs about a second instead of twenty.

## Why it is built this way

Wrapping a screenshot in a general-purpose vision CLI costs 15-20s per frame,
because the model is asked to fill a large structured schema. Watching a screen
needs the opposite: one short sentence, fast. So this plugin:

- keeps one PowerShell process alive (Add-Type loads once, frames cost ~100ms
  instead of ~900ms of process startup),
- keeps a warm HTTP connection to an OpenAI-compatible vision endpoint and asks
  for <=25 characters with thinking disabled,
- skips the vision call entirely when the frame is perceptually unchanged
  (aHash Hamming distance),
- exposes watch, which returns many frames from a single tool call so the
  agent turn overhead is paid once per burst, not once per frame.

## Layout

    lib/capture-worker.ps1  resident PowerShell worker (stdin commands, base64 frames)
    lib/capture.mjs         worker lifecycle and request/response framing
    lib/vision.mjs          the vision call, with model fallback
    lib/daemon.mjs          loopback HTTP server on 127.0.0.1:37711
    lib/client.mjs          ensure-daemon + call helpers
    lib/index.js            cordis plugin: screen_look / screen_watch / screen_doctor
    bin/eyes.mjs            the same pipeline as a CLI, usable without a restart

## Config

    ~/.dsh-watch-eyes/config.json

Seeded from the modlens Zhipu provider on first run. Useful keys:

    provider.model          default glm-4.6v
    provider.fallbackModels default [glm-4.6v-flashx, glm-5v-turbo]
    capture.width           default 960
    capture.quality         default 75
    capture.window          default "" (whole virtual desktop)
    capture.diffThreshold   default 3 (aHash bits; 0 disables skipping)
    prompt                  the default one-line question
    thinking                default false (disable the chain of thought)

## CLI

    node bin/eyes.mjs look --text
    node bin/eyes.mjs look --window "PotPlayer" --prompt "字幕写了什么"
    node bin/eyes.mjs watch --seconds 20 --every 3 --text
    node bin/eyes.mjs windows
    node bin/eyes.mjs doctor
    node bin/eyes.mjs status
    node bin/eyes.mjs stop
    node bin/eyes.mjs config set provider.model glm-4.6v
