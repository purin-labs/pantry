"""Render the Blender asset and replay Rust-recorded physics without advancing time."""

import json
import subprocess

import bpy
import mujoco
import numpy as np
from mathutils import Vector
from prepare import ASSETS

DIRECTORY = ASSETS / "fanuc-crx10ial"


def render_stills() -> None:
    bpy.ops.wm.open_mainfile(filepath=str(DIRECTORY / "robot.blend"))
    scene = bpy.context.scene
    scene.cycles.samples = 64
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1400
    scene.render.filepath = str(DIRECTORY / "preview.png")
    bpy.ops.render.render(write_still=True)
    camera = scene.camera
    target = Vector((0.45, -0.13, 0.58))
    camera.location = target + Vector((0, -4, 0))
    camera.rotation_euler = (
        (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.ortho_scale = 1.7
    scene.render.filepath = str(DIRECTORY / "studio-front.png")
    bpy.ops.render.render(write_still=True)
    target = bpy.data.objects["fanuc-crx10ial__flange"].matrix_world.translation
    camera.location = target + Vector((0.6, -1, 0.6))
    camera.rotation_euler = (
        (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.ortho_scale = 0.46
    scene.render.filepath = str(DIRECTORY / "studio-flange.png")
    bpy.ops.render.render(write_still=True)


def replay_physics() -> None:
    evidence = DIRECTORY / "acceptance"
    trace = json.loads((evidence / "loaded-trace.json").read_text())
    model = mujoco.MjModel.from_xml_path(str(evidence / "loaded.xml"))
    data = mujoco.MjData(model)
    model.vis.global_.offwidth = 960
    model.vis.global_.offheight = 720
    camera = mujoco.MjvCamera()
    camera.lookat[:] = (0.4, 0, 0.65)
    camera.distance = 2.35
    camera.azimuth = 125
    camera.elevation = -18
    option = mujoco.MjvOption()
    option.geomgroup[3] = 0
    process = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            "960x720",
            "-r",
            "20",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(evidence / "loaded-motion.mp4"),
        ],
        stdin=subprocess.PIPE,
    )
    peak_contacts = 0
    with mujoco.Renderer(model, height=720, width=960) as renderer:
        for sample in trace:
            data.qpos[:] = sample["joints"]
            mujoco.mj_forward(model, data)
            peak_contacts = max(peak_contacts, data.ncon)
            np.testing.assert_allclose(
                data.site("fanuc-crx10ial__flange").xpos, sample["flange_m"], atol=1e-10
            )
            renderer.update_scene(data, camera=camera, scene_option=option)
            process.stdin.write(renderer.render().tobytes())
    process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("Video encoder failed")
    assert peak_contacts == 0, "Unexpected contacts during loaded motion"
    (evidence / "replay-report.json").write_text(
        json.dumps(
            {
                "passed": True,
                "frames": len(trace),
                "fps": 20,
                "sampled_arm_contacts": peak_contacts,
                "source": "Rust loaded-trace.json; MuJoCo forward kinematics only",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    render_stills()
    replay_physics()
