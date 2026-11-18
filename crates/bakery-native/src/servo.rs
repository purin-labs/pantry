//! The six-joint arm of a robot world and its position servos. The transfer
//! world and the pour-over station share this code; each gives its own
//! carried load.
use anyhow::{Result, bail, ensure};

use crate::mj::{self, Data, Model, Object, Stages};
use crate::robot::Robot;

/// The proportional gain of each arm servo, in N·m/rad.
pub const GAINS: [f64; 6] = [1500., 1500., 1000., 300., 200., 100.];

/// Where the six arm joints are in the model.
pub struct Arm {
    pub positions: [usize; 6],
    pub velocities: [usize; 6],
    pub actuators: [usize; 6],
    pub limits: [(f64, f64); 6],
}

impl Arm {
    /// Binds the robot's hinge joints and their `__servo` actuators.
    /// `id` looks up a named object, with the caller's error for a missing one.
    pub fn bind(
        model: &Model,
        robot: Robot,
        id: impl Fn(Object, &str) -> Result<usize>,
    ) -> Result<Self> {
        let mut arm = Self {
            positions: [0; 6],
            velocities: [0; 6],
            actuators: [0; 6],
            limits: [(0., 0.); 6],
        };
        for index in 0..6 {
            let name = robot.joint(index);
            let joint = id(Object::Joint, &name)?;
            ensure!(
                model.jnt_type()[joint] == mj::JOINT_HINGE,
                "Arm joint must be a hinge"
            );
            arm.positions[index] = model.jnt_qposadr()[joint] as usize;
            arm.velocities[index] = model.jnt_dofadr()[joint] as usize;
            arm.limits[index] = (
                model.jnt_range()[joint * 2],
                model.jnt_range()[joint * 2 + 1],
            );
            arm.actuators[index] = id(Object::Actuator, &format!("{name}__servo"))?;
        }
        Ok(arm)
    }

    pub fn joints(&self, data: &Data) -> [f64; 6] {
        let qpos = data.qpos();
        let mut result = [0.; 6];
        for (index, angle) in result.iter_mut().enumerate() {
            *angle = qpos[self.positions[index]];
        }
        result
    }

    pub fn set_joints(&self, data: &mut Data, angles: &[f64; 6]) {
        let qpos = data.qpos_mut();
        for (index, angle) in angles.iter().enumerate() {
            qpos[self.positions[index]] = *angle;
        }
    }

    /// The fastest arm joint, in rad/s.
    pub fn speed(&self, data: &Data) -> f64 {
        let qvel = data.qvel();
        let mut fastest: f64 = 0.;
        for dof in self.velocities {
            fastest = fastest.max(qvel[dof].abs());
        }
        fastest
    }
}

/// A carried load that the servos compensate: its mass, acting at `point`
/// on `body`, through that body's Jacobian.
pub struct Payload {
    pub body: usize,
    pub point: [f64; 3],
    pub mass: f64,
}

/// Sets the servo targets that hold `angles`: model-based bias compensation,
/// plus ideal known-payload compensation of `payload`.
pub fn command(
    model: &Model,
    data: &mut Data,
    arm: &Arm,
    angles: &[f64; 6],
    payload: Option<Payload>,
) {
    let nv = model.nv();
    let mut jacobian = vec![0.; 3 * nv];
    if let Some(payload) = &payload {
        model.jac_point(data, &payload.point, payload.body, &mut jacobian);
    }
    let gravity = model.gravity();
    let mut targets = [0.; 6];
    for (index, target) in targets.iter_mut().enumerate() {
        let dof = arm.velocities[index];
        let mut feed_forward = data.qfrc_bias()[dof];
        if let Some(payload) = &payload {
            for axis in 0..3 {
                feed_forward -= jacobian[axis * nv + dof] * payload.mass * gravity[axis];
            }
        }
        *target = angles[index] + feed_forward / GAINS[index];
    }
    let ctrl = data.ctrl_mut();
    for (index, target) in targets.into_iter().enumerate() {
        ctrl[arm.actuators[index]] = target;
    }
}

/// Ends a servo step after `Model::step`: the state must be finite with no
/// MuJoCo warning (else `invalid`), the forward runs, and no actuator may
/// exceed its force range.
pub fn settle(model: &Model, data: &mut Data, stages: &mut Stages, invalid: &str) -> Result<()> {
    ensure!(data.valid(), "{invalid}");
    model.forward_after_step(data, stages);
    let range = model.actuator_forcerange();
    for (id, force) in data.actuator_force().iter().enumerate() {
        if force.abs() > range[id * 2 + 1] + 1e-6 {
            bail!("Actuator force bound violated");
        }
    }
    Ok(())
}
