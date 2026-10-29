# Combat stress test

2026-10-25T19:56:36.317Z  |  10 devices, 4 rounds, 10 heroes vs 20 creatures (3 hidden), loopback only

Runs on this computer over loopback, so it measures the server and the protocol, not your router or phones.

| | Check | Result | Criterion | |
|---|---|---|---|---|
| S1 | drag a token: arrives on the other 9 good devices (2808 samples) | `{"n":2808,"p50":2.3,"p95":3.2,"p99":8.8,"max":15.4}` | p95 <= 40 ms, p99 <= 100 ms | PASS |
| S2 | turn passes: every good device shows the new turn | `{"n":1158,"p50":9,"p95":14.2,"p99":17.5,"max":29.4}` | p95 <= 60 ms | PASS |
| S3 | ping: shown on every other good device | `{"n":420,"p50":1.1,"p95":1.6,"p99":1.9,"max":2.2}` | p95 <= 40 ms | PASS |
| S4 | nothing lost: moves, pings, turn changes and end-turns all arrived | `{"movesMissed":0,"pingsMissed":0,"turnMissed":0,"endTurnsHeard":"40/40","movesAtGm":"355/355"}` | all zero / all delivered (bad-Wi-Fi devices may be late but must arrive) | PASS |
| S5 | privacy: hidden tokens and creature hit points never reached a player | `{"leakedFrames":0}` | 0 | PASS |
| S6 | integrity: no device ever disagreed with the server | `{"divergence":0,"patchGaps":0,"devicesAgreeingAtEnd":"10/10"}` | divergence 0, all devices agree at the end | PASS |
| S7 | rejected actions (should be none in a normal fight) | `{}` | none | PASS |
| S8 | phones that dropped and came back caught up | `[{"device":1,"caughtUpMs":16.5,"patchesNotFull":true},{"device":8,"caughtUpMs":14.8,"patchesNotFull":true}]` | each caught up within 3 s | PASS |
| S9 | a frozen phone did not hurt anyone else, and recovered | `{"freeze":{"device":9,"closedByServer":null,"caughtUpMs":8.9,"fullsAfter":1,"gaps":0,"stillOpen":true},"othersDuringFreezeP95":3.2}` | others p95 <= 100 ms; the phone caught up or was dropped and reconnected within 6 s | PASS |
| S10 | server: event loop stayed responsive | `{"loopDelayP99Ms":17.5,"loopDelayMaxMs":21.3,"cpuPercentOfOneCore":6.3}` | p99 delay <= 25 ms | PASS |
| S11 | server memory: nothing piles up | `{"liveHeapGrowthMB":-1.9,"externalGrowthMB":-0.4,"info":{"processStart":"70.2 MB","processPeak":"90.8 MB","processEnd":"90.8 MB","processAfterGc":"90.1 MB","v8ReservedHeap":"29.4 MB (start 18.6)"}}` | live heap and external memory growth <= 8 MB each after a full garbage collection | PASS |
| S12 | traffic | `{"fightSeconds":37,"receivedPerDeviceKB":262,"perDeviceKBps":7.2,"patchBytes":{"p50":193,"p95":1968,"max":2180,"count":4770},"fullSnapshots":8,"unexpectedClosed":0}` | about one snapshot per device (plus reconnects); no device closed | PASS |

**All checks passed.**
