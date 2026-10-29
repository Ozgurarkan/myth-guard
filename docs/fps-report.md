# FPS test

2026-10-25T20:56:34.811Z  |  headless Edge (software drawing: conservative for a PC with a graphics card)  |  map 4096 x 3072, 30 tokens, combat running  |  weak-machine slowdown 4x

Targets: normal speed average >= 50 fps and 1% low >= 30 fps; slowed 4x average >= 30 fps and 1% low >= 15 fps.

| Screen | CPU | Action | Avg fps | 1% low fps | Frames >33 ms | Frames >50 ms | Worst frame | |
|---|---|---|---:|---:|---:|---:|---:|---|
| GM | 1x | idle, turn ring pulsing | 144 | 138.9 | 0 | 0 | 7.2 ms | PASS |
| GM | 1x | pings rippling | 144 | 138.9 | 0 | 0 | 7.2 ms | PASS |
| GM | 1x | wheel zoom | 144 | 138.9 | 0 | 0 | 7.3 ms | PASS |
| GM | 1x | panning (H tool) | 144 | 138.9 | 0 | 0 | 7.3 ms | PASS |
| GM | 1x | dragging a token | 144 | 138.9 | 0 | 0 | 7.2 ms | PASS |
| GM | 1x | painting fog | 144 | 138.9 | 0 | 0 | 7.3 ms | PASS |
| GM | 4x | idle, turn ring pulsing | 133.7 | 71.4 | 0 | 0 | 20.9 ms | PASS |
| GM | 4x | pings rippling | 103.1 | 28.7 | 6 | 0 | 41.7 ms | PASS |
| GM | 4x | wheel zoom | 84.9 | 23.9 | 13 | 1 | 62.4 ms | PASS |
| GM | 4x | panning (H tool) | 91 | 24 | 23 | 2 | 55.7 ms | PASS |
| GM | 4x | dragging a token | 135.3 | 47.6 | 1 | 0 | 34.8 ms | PASS |
| GM | 4x | painting fog | 108 | 20.5 | 19 | 6 | 83.4 ms | PASS |
| Phone | 4x | idle | 138.7 | 71.9 | 1 | 1 | 62.5 ms | PASS |
| Phone | 4x | pings rippling | 126.3 | 47.8 | 1 | 0 | 41.5 ms | PASS |
| Phone | 4x | wheel zoom | 101.6 | 28.8 | 8 | 1 | 55.6 ms | PASS |
| Phone | 4x | one-finger pan | 140.8 | 71.9 | 0 | 0 | 20.7 ms | PASS |
| Phone | 4x | two-finger pinch | 127 | 47.8 | 0 | 0 | 27.8 ms | PASS |

**All 17 measurements met the targets.**
