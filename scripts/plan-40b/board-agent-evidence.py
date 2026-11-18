#!/usr/bin/env python3
"""Write the evidence of the board agent journey (Plan 40B phase 7).

Reads the results of scripts/plan-40b/browser-board-agent.js from its
artifacts folder, converts the chosen screenshots to JPEG with sips, and
writes docs/evidence/plan-40b-phase-7/board-agent-browser.json: the checks,
the agent tags, the timeline of each streamed edit, the presence frames that
the viewer received (time from the first frame, agent, kind, state, element
IDs, rect and text length) and the SHA-256 digest of each picture.

Run after the journey:
  python3 scripts/plan-40b/board-agent-evidence.py output/playwright/plan-40b-agent
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/evidence/plan-40b-phase-7"
PICTURES = [
    "22-agent-moves-heading",
    "23-agent-resizes-heading",
    "24-agent-adds-note",
    "25b-viewer-sees-text",
    "30-viewer-sees-move-ghost",
    "31-viewer-sees-ghost-box",
    "32-viewer-sees-text-as-written",
    "33-viewer-sees-note",
    "34-viewer-sees-rewrite",
    "35-owner-drags-with-spacing",
    "36-viewer-sees-drag-spacing",
    "37-viewer-presence-bar",
    "38-owner-sees-stop",
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    artifacts = Path(sys.argv[1]).resolve()
    results = json.loads((artifacts / "kitchen-run-browser-results.json").read_text())
    journey = results["journey"]
    if journey.get("result") != "passed":
        raise SystemExit("The journey did not pass")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    pictures = []
    for name in PICTURES:
        source = artifacts / f"{name}.png"
        target = EVIDENCE / f"{name}.jpg"
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72",
             "--resampleWidth", "1600", str(source), "--out", str(target)],
            check=True, capture_output=True,
        )
        pictures.append({"file": target.name, "sha256": digest(target), "sourcePngSha256": digest(source)})
    frames = journey["frames"]["viewer"]
    first = frames[0]["at"] if frames else 0
    # Element and operation IDs differ in each run; the evidence names them
    # by their order, so that two runs compare.
    names: dict[str, str] = {}

    def name(value: str, prefix: str) -> str:
        if value not in names:
            names[value] = f"{prefix}{sum(1 for key in names.values() if key.startswith(prefix)) + 1}"
        return names[value]

    viewer = [
        {
            "ms": frame["at"] - first,
            "agents": [
                {
                    "agent": agent["agent"],
                    "colorKey": agent["colorKey"],
                    "operation": name(agent["operationId"], "operation_"),
                    "draft": agent["operationId"].startswith("draft:"),
                    "kind": agent["kind"],
                    "state": agent["state"],
                    "elements": [name(element, "element_") for element in agent["elementIds"]],
                    "rect": agent["rect"],
                    "field": agent["field"],
                    "textLength": agent["textLength"],
                }
                for agent in frame["agents"]
            ],
        }
        for frame in frames
    ]
    evidence = {
        "journey": "scripts/plan-40b/browser-board-agent.js",
        "runner": "scripts/plan-81/run-browser.py --entry /menu-chat-preview.html --setup-path /test/setup-menu",
        "backend": results["backend"],
        "identity": "two browser contexts (Owner, and Member as a viewer) with real control sessions",
        "account": results["account"],
        "model": "simulated provider: a fixed script whose board edits stream their arguments in parts, the text two letters at a time",
        "checks": [{"name": check["name"], "passed": check["passed"]} for check in journey["checks"]],
        "tags": journey["marks"],
        "layersBadge": journey["layer"],
        "streamedEdits": journey["timeline"],
        "viewerPresenceFrames": viewer,
        "pictures": pictures,
    }
    (EVIDENCE / "board-agent-browser.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(evidence['checks'])} checks, {len(viewer)} viewer frames, {len(pictures)} pictures")


if __name__ == "__main__":
    main()
