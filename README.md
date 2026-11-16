# markdown-render-speed-02

Fast single-pass Markdown parser for make.fun — returns byte-for-byte identical HTML to marked 18.1.3, but faster.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Endodo713/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Endodo713/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

An entry for [make.fun bounty markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

## How it works

- `parse.js` — dependency-free ES module. `parse(markdown)` returns exactly marked 18.1.3's HTML (gfm, breaks off). Short inputs (< 1000 bytes) go to a vendored marked; long inputs (READMEs) go through the hand-written single-pass fast parser.
- `main.ts` — Node 22 driver. Reads `/input/cases.json`, renders each case with `parse()`, writes `/output/html.json`.
- `vendor/marked/` — vendored marked 18.1.3 (MIT, with LICENSE + NOTICE).

## Verification

Practice set: **720/720 correct** (652 CommonMark + 28 GFM + 40 generated READMEs), byte-for-byte identical to marked.
