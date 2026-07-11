# Packaged display-scaling walkthrough

Run ID: `2026-07-11T00-07-21-914Z-3943a614`

Result: **PASS** at `100%`, `125%`, and `150%` Chromium device scale.

## Observed bounds

| Scale | Captured device bounds | Stable views checked |
| ---: | ---: | --- |
| `100%` | `390 x 640` | Raft and Brain settings |
| `125%` | `490 x 805` | Raft, Cypher card back, and Brain settings |
| `150%` | `588 x 960` | Raft, Brain settings, and Device settings |

At every scale, Windows computer use confirmed:

- the complete egg shell remained visible;
- the generated side Settings button remained inside the window capture and clickable;
- the top controls, status strip, screen, mode dots, and hardware Mode button did not overlap;
- the Cypher, raft, water, and status counters remained inside the display;
- Brain fields plus Test and Save remained reachable;
- Device backup, restore, emergency-key, refresh, address, and login controls remained reachable.

The walkthrough marker was returned to factor `1` after the matrix. Scale transitions are append-only events in `events.jsonl`.

## Captures

Stable PNGs are under `scaling/`:

- `scale-100-raft.png`
- `scale-100-brain-settings.png`
- `scale-125-raft.png`
- `scale-125-brain-settings.png`
- `scale-125-mode-visible.png`
- `scale-150-raft.png`
- `scale-150-brain-settings.png`
- `scale-150-device-settings.png`

This pass proves layout containment at the supported walkthrough scales. It does not replace the owner's final aesthetic approval.
