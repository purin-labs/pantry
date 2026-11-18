//! Offline asset acceptance through the shared native engine. No workflow dispatch.
use anyhow::{Result, ensure};
use bakery_native::{native::ApplianceEngine, servo::GAINS};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{fs, path::Path};

#[derive(Deserialize)]
struct Joint {
    node: String,
    body: String,
    limits_rad: [f64; 2],
    source_effort_nm: f64,
    source_velocity_rad_s: f64,
}

#[derive(Deserialize)]
struct Arm {
    home_rad: [f64; 6],
    rated_payload_kg: f64,
    joint_order: [Joint; 6],
}

impl Arm {
    fn joint(&self, index: usize) -> &str {
        &self.joint_order[index].node
    }

    fn servo(&self, index: usize) -> String {
        format!("{}__servo", self.joint(index))
    }

    fn flange(&self) -> String {
        let (prefix, _) = self.joint(0).split_once("__").unwrap();
        format!("{prefix}__flange")
    }

    fn target(&self) -> [f64; 6] {
        let offsets = [0.45, -0.15, 0.15, 0.15, 0.3, 0.25];
        std::array::from_fn(|index| self.home_rad[index] + offsets[index])
    }
}

fn command(arm: &Arm, engine: &mut ApplianceEngine, target: &[f64; 6]) -> Result<()> {
    for index in 0..6 {
        let feed_forward = engine.joint_bias_force(arm.joint(index))? / GAINS[index];
        engine.control(&arm.servo(index), target[index] + feed_forward)?;
    }
    Ok(())
}

fn sample(arm: &Arm, engine: &ApplianceEngine) -> Result<Value> {
    let mut angles = Vec::new();
    let mut forces = Vec::new();
    for index in 0..6 {
        angles.push(engine.joint(arm.joint(index))?.0);
        forces.push(engine.actuator_force(&arm.servo(index))?);
    }
    Ok(
        json!({"time": engine.time(), "joints": angles, "torques_nm": forces,
        "flange_m": engine.site(&arm.flange())?}),
    )
}

fn exercise(arm: &Arm, directory: &Path, case: &str) -> Result<Value> {
    let path = directory.join(format!("{case}.xml"));
    let mut engine = ApplianceEngine::load(&path)?;
    let initial: Vec<f64> = serde_json::from_slice(&fs::read(
        directory.join(format!("{case}-initial-state.json")),
    )?)?;
    engine.restore_state(&initial)?;
    engine.forward();
    let mut trace = Vec::new();
    let mut peak_force = [0_f64; 6];
    let mut peak_speed = [0_f64; 6];
    let mut peak_tracking = 0_f64;
    let mut recovery_peak = 0_f64;
    let mut hold_force = [0_f64; 6];
    for step in 0..6000 {
        let time = engine.time();
        let fraction = (time / 4.).clamp(0., 1.);
        let smooth = fraction.powi(3) * (10. - 15. * fraction + 6. * fraction.powi(2));
        let mut target = arm.home_rad;
        for index in 0..6 {
            target[index] += (arm.target()[index] - arm.home_rad[index]) * smooth;
        }
        command(arm, &mut engine, &target)?;
        let disturbance = if (7.0..7.15).contains(&time) { 30. } else { 0. };
        engine.apply_force(&arm.joint_order[5].body, [0., disturbance, 0., 0., 0., 0.])?;
        engine.step()?;
        for index in 0..6 {
            let (angle, speed) = engine.joint(arm.joint(index))?;
            let force = engine.actuator_force(&arm.servo(index))?.abs();
            ensure!(
                force <= arm.joint_order[index].source_effort_nm + 1e-6,
                "Torque limit exceeded"
            );
            ensure!(
                speed.abs() <= arm.joint_order[index].source_velocity_rad_s,
                "Source speed limit exceeded"
            );
            ensure!(
                (arm.joint_order[index].limits_rad[0]..=arm.joint_order[index].limits_rad[1])
                    .contains(&angle),
                "Joint range exceeded"
            );
            peak_force[index] = peak_force[index].max(force);
            peak_speed[index] = peak_speed[index].max(speed.abs());
            peak_tracking = peak_tracking.max((angle - target[index]).abs());
            if (7.0..8.0).contains(&time) {
                recovery_peak = recovery_peak.max((angle - arm.target()[index]).abs());
            }
            if step == 2999 {
                hold_force[index] = engine.actuator_force(&arm.servo(index))?;
            }
        }
        if step % 25 == 0 {
            trace.push(sample(arm, &engine)?);
        }
    }
    let mut final_error = 0_f64;
    for (index, target) in arm.target().iter().enumerate() {
        let (angle, speed) = engine.joint(arm.joint(index))?;
        final_error = final_error.max((angle - target).abs());
        ensure!(
            (angle - target).abs() < 0.001 && speed.abs() < 0.001,
            "Failed to settle"
        );
    }
    ensure!(recovery_peak > 0.0001, "Disturbance did not affect the arm");
    ensure!(peak_tracking < 0.08, "Excessive tracking error");
    let state = engine.state();
    fs::write(
        directory.join(format!("{case}-checkpoint.json")),
        serde_json::to_vec(&state)?,
    )?;
    let saved: Vec<f64> = serde_json::from_slice(&fs::read(
        directory.join(format!("{case}-checkpoint.json")),
    )?)?;
    let mut restored = ApplianceEngine::load(&path)?;
    restored.restore_state(&saved)?;
    for _ in 0..250 {
        command(arm, &mut engine, &arm.target())?;
        command(arm, &mut restored, &arm.target())?;
        engine.step()?;
        restored.step()?;
    }
    let resume_difference = engine
        .state()
        .iter()
        .zip(restored.state())
        .map(|(first, second)| (first - second).abs())
        .fold(0_f64, f64::max);
    ensure!(resume_difference < 1e-9, "Restored simulation diverged");
    let before = engine.joint(arm.joint(1))?.0;
    for index in 0..6 {
        engine.actuator(&arm.servo(index), 0., 0., 0., 0.)?;
    }
    for _ in 0..50 {
        engine.step()?;
    }
    let gravity_motion = (engine.joint(arm.joint(1))?.0 - before).abs();
    ensure!(
        gravity_motion > 0.001,
        "Unpowered arm did not respond to gravity"
    );
    fs::write(
        directory.join(format!("{case}-trace.json")),
        serde_json::to_vec(&trace)?,
    )?;
    Ok(
        json!({"case": case, "seconds": 12., "peak_torque_nm": peak_force,
        "peak_speed_rad_s": peak_speed, "peak_tracking_error_rad": peak_tracking,
        "disturbance_peak_error_rad": recovery_peak, "settled_error_rad": final_error,
        "hold_torque_nm": hold_force, "resume_max_difference": resume_difference,
        "unpowered_shoulder_motion_rad": gravity_motion, "engine_warnings": 0}),
    )
}

fn main() -> Result<()> {
    let directory = std::env::args()
        .nth(1)
        .expect("Pass the prepared evidence directory");
    let directory = Path::new(&directory);
    let arm: Arm = serde_json::from_slice(&fs::read(directory.join("../joints.json"))?)?;
    let arm = &arm;
    let initial: Vec<f64> =
        serde_json::from_slice(&fs::read(directory.join("unloaded-initial-state.json"))?)?;
    let unloaded = exercise(arm, directory, "unloaded")?;
    let loaded = exercise(arm, directory, "loaded")?;
    let unloaded_shoulder = unloaded["hold_torque_nm"][1].as_f64().unwrap().abs();
    let loaded_shoulder = loaded["hold_torque_nm"][1].as_f64().unwrap().abs();
    ensure!(
        loaded_shoulder > unloaded_shoulder + 20.,
        "Payload did not increase joint load"
    );
    let mut contact = ApplianceEngine::load(&directory.join("obstacle.xml"))?;
    contact.restore_state(&initial)?;
    contact.forward();
    let mut contact_force = 0_f64;
    for _ in 0..10 {
        command(arm, &mut contact, &arm.home_rad)?;
        contact.step()?;
        contact_force = contact_force.max(contact.contact_force(
            "acceptance_obstacle",
            &format!("{}__collision", arm.joint_order[2].body),
        )?);
    }
    ensure!(
        contact_force > 1.,
        "Obstacle contact did not generate force"
    );
    let report = json!({"passed": true, "engine": "bakery-native::native::ApplianceEngine",
        "mujoco": "4.0.0", "payload_kg": arm.rated_payload_kg, "disturbance": "30 N lateral wrist force for 0.15 s",
        "control": "Assumed PD servos with ideal model bias compensation; prepared torque caps; see per-model fidelity assumptions",
        "cases": [unloaded, loaded], "obstacle_peak_normal_force_n": contact_force});
    fs::write(
        directory.join("physics-report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
