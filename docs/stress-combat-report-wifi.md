# Combat stress test

2026-10-25T19:57:49.941Z  |  10 devices, 4 rounds, 10 heroes vs 20 creatures (3 hidden), 4 devices on a simulated bad Wi-Fi link

Runs on this computer over loopback, so it measures the server and the protocol, not your router or phones.

| | Check | Result | Criterion | |
|---|---|---|---|---|
| S1 | drag a token: arrives on the other 5 good devices (1835 samples) | `{"n":1835,"p50":3.2,"p95":34.1,"p99":34.9,"max":41.3}` | p95 <= 40 ms, p99 <= 100 ms | PASS |
| S2 | turn passes: every good device shows the new turn | `{"n":695,"p50":9.1,"p95":13,"p99":15.7,"max":19.9}` | p95 <= 60 ms | PASS |
| S3 | ping: shown on every other good device | `{"n":279,"p50":16,"p95":32.6,"p99":33.6,"max":34}` | p95 <= 40 ms | PASS |
| S4 | nothing lost: moves, pings, turn changes and end-turns all arrived | `{"movesMissed":0,"pingsMissed":0,"turnMissed":0,"endTurnsHeard":"40/40","movesAtGm":"355/355"}` | all zero / all delivered (bad-Wi-Fi devices may be late but must arrive) | PASS |
| S5 | privacy: hidden tokens and creature hit points never reached a player | `{"leakedFrames":0}` | 0 | PASS |
| S6 | integrity: no device ever disagreed with the server | `{"divergence":0,"patchGaps":0,"devicesAgreeingAtEnd":"10/10"}` | divergence 0, all devices agree at the end | PASS |
| S7 | rejected actions (should be none in a normal fight) | `{}` | none | PASS |
| S8 | phones that dropped and came back caught up | `[{"device":1,"caughtUpMs":18.1,"patchesNotFull":true},{"device":8,"caughtUpMs":138.4,"patchesNotFull":true}]` | each caught up within 3 s | PASS |
| S9 | a frozen phone did not hurt anyone else, and recovered | `{"freeze":{"device":9,"closedByServer":null,"caughtUpMs":5.4,"fullsAfter":1,"gaps":0,"stillOpen":true},"othersDuringFreezeP95":3.2}` | others p95 <= 100 ms; the phone caught up or was dropped and reconnected within 6 s | PASS |
| S10 | server: event loop stayed responsive | `{"loopDelayP99Ms":16.6,"loopDelayMaxMs":20.8,"cpuPercentOfOneCore":3.6}` | p99 delay <= 25 ms | PASS |
| S11 | server memory: nothing piles up | `{"liveHeapGrowthMB":-2.2,"externalGrowthMB":-0.5,"info":{"processStart":"70.8 MB","processPeak":"90.8 MB","processEnd":"90.8 MB","processAfterGc":"89.9 MB","v8ReservedHeap":"27.6 MB (start 18.4)"}}` | live heap and external memory growth <= 8 MB each after a full garbage collection | PASS |
| S12 | traffic | `{"fightSeconds":71,"receivedPerDeviceKB":243,"perDeviceKBps":3.4,"patchBytes":{"p50":195,"p95":1817,"max":2085,"count":4770},"fullSnapshots":8,"unexpectedClosed":0}` | about one snapshot per device (plus reconnects); no device closed | PASS |
| W1 | bad-Wi-Fi devices (4): drag, turn and ping still arrive | `{"move":{"n":1258,"p50":46.9,"p95":78.8,"p99":343,"max":697.9},"turn":{"n":456,"p50":47,"p95":62.5,"p99":280.6,"max":358.4},"ping":{"n":176,"p50":46.8,"p95":78.2,"p99":79.3,"max":327.5}}` | informational (14 ms base, 26 ms jitter, 1% loss, stalls up to 0.7 s) | info |

**All checks passed.**
