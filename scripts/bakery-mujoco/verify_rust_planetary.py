"""Run bowl removal and tool exchange through separate Rust processes."""

import json

from verify_rust_appliances import OUTPUT, execute
from verify_rust_handling import advance


def attachment(kind, part, parking=False):
    action = {"kind": kind, "part": part}
    if kind != "grasp-attachment":
        action["parking"] = parking
    return action


def move_part(part, position, quaternion=(1, 0, 0, 0)):
    return {
        "kind": "move-attachment",
        "part": part,
        "position": position,
        "quaternion": quaternion,
    }


def run(name):
    aicoh = name == "aicoh-ms-30"
    prefix = "ms" if aicoh else "hl"
    installed = "whip" if aicoh else "beater"
    replacement = "beater" if aicoh else "whip"
    initial = {"kind": "fresh", "appliance": name, "contents": {"kind": "empty"}}
    opened = execute(
        name + "-attachments-open",
        initial,
        [
            {"kind": "guard", "open": True},
            {"kind": "bowl-lift", "raised": False},
            advance(3),
        ],
    )
    opened = execute(
        name + "-attachments-open-start-rejected",
        {"kind": "continue", "checkpoint": opened["continuation"]},
        [
            {
                "kind": "start",
                "program": {
                    "kind": "planetary",
                    "setting": 1,
                    "duration_s": 3,
                },
            }
        ],
        expected="rejected",
    )
    home = opened["samples"][-1]["bodies"][prefix + "_bowl"][:3]
    tool_home = opened["samples"][-1]["bodies"][prefix + "_" + installed][:3]
    tool_quat = opened["samples"][-1]["bodies"][prefix + "_" + installed][3:]
    bowl_out = [0, -0.95, home[2] + 0.006]
    tool_out = [tool_home[0], tool_home[1] - 0.75, tool_home[2] + 0.006]
    removed = execute(
        name + "-attachments-removed",
        {"kind": "continue", "checkpoint": opened["continuation"]},
        [
            attachment("grasp-attachment", "bowl"),
            attachment("grasp-attachment", installed),
            move_part("bowl", bowl_out),
            move_part(installed, tool_out, tool_quat),
            advance(5),
            move_part(
                installed, [tool_out[0], tool_out[1], tool_out[2] + 0.55], tool_quat
            ),
            advance(4),
            attachment("move-to-attachment", installed, True),
            advance(5),
            attachment("engage-attachment", installed, True),
            {"kind": "release-attachment", "part": "bowl"},
            advance(2),
        ],
    )
    pose = removed["samples"][-1]["bodies"][prefix + "_bowl"]
    assert abs(pose[1] + 0.95) < 0.02, pose
    rejected = execute(
        name + "-attachments-rejected",
        {"kind": "continue", "checkpoint": removed["continuation"]},
        [attachment("engage-attachment", "bowl")],
        expected="rejected",
    )
    selected = execute(
        name + "-attachments-selected",
        {"kind": "continue", "checkpoint": rejected["continuation"]},
        [
            attachment("grasp-attachment", "bowl"),
            move_part("bowl", bowl_out),
            attachment("grasp-attachment", replacement),
            move_part(
                replacement, [tool_out[0], tool_out[1], tool_out[2] + 0.55], tool_quat
            ),
            advance(5),
            move_part(replacement, tool_out, tool_quat),
            advance(4),
        ],
    )
    actions = []
    for index in range(1, 41):
        fraction = index / 40
        for part, target in (
            ("bowl", [home[0], home[1], home[2] + 0.006]),
            (replacement, [tool_home[0], tool_home[1], tool_home[2] + 0.006]),
        ):
            origin = selected["samples"][-1]["bodies"][prefix + "_" + part][:3]
            position = [
                origin[axis] + fraction * (target[axis] - origin[axis])
                for axis in range(3)
            ]
            actions.append(
                move_part(part, position, (1, 0, 0, 0) if part == "bowl" else tool_quat)
            )
        actions.append(advance(0.15))
    actions += [
        attachment("move-to-attachment", "bowl"),
        attachment("move-to-attachment", replacement),
        advance(4),
        attachment("engage-attachment", "bowl"),
        attachment("engage-attachment", replacement),
        {"kind": "bowl-lift", "raised": True},
        {"kind": "guard", "open": False},
        advance(3),
        {
            "kind": "start",
            "program": {"kind": "planetary", "setting": 1, "duration_s": 3},
        },
        advance(4),
        {"kind": "require", "state": "complete"},
    ]
    swapped = execute(
        name + "-attachments-swapped",
        {"kind": "continue", "checkpoint": selected["continuation"]},
        actions,
    )
    return {
        "passed": True,
        "replacement": replacement,
        "bench_pose": pose,
        "coupling_rejection": rejected["outcome"],
        "final_state": swapped["continuation"]["payload"]["controller"]["motor"]["state"],
    }


def main():
    report = {}
    for name in ("aicoh-ms-30", "hobart-hl200"):
        report[name] = run(name)
        print(name, "passed")
    (OUTPUT / "planetary-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
