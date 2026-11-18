//! Damped least-squares inverse kinematics of a six-joint arm, on a data
//! that the solver owns. Each world keeps its own solver limits: one shared
//! set changed the samples of both worlds (Refactor 16, step 5).
use nalgebra::{Matrix3, SMatrix, SVector, Vector3};

use crate::mj::{self, Data, Model};
use crate::servo::Arm;

type Matrix6 = SMatrix<f64, 6, 6>;
type Vector6 = SVector<f64, 6>;

/// The iteration count, the error norm that ends a solve, and the damping.
pub struct Limits {
    pub iterations: usize,
    pub tolerance: f64,
    pub damping: f64,
}

/// The orientation that the site must reach.
pub enum Orientation<'a> {
    /// The site's axes are the world axes.
    World,
    /// A row-major rotation matrix.
    Rows(&'a [f64; 9]),
}

/// Solves the arm angles that put `site` at `position` with `orientation`,
/// from `seed`. `data` holds only the solver's state: the arm angles are the
/// only positions written to it. `iterations` counts each iteration run.
#[allow(clippy::too_many_arguments)]
pub fn solve(
    model: &Model,
    data: &mut Data,
    arm: &Arm,
    site: usize,
    position: Vector3<f64>,
    orientation: Orientation,
    seed: [f64; 6],
    limits: &Limits,
    iterations: &mut u64,
) -> Option<[f64; 6]> {
    arm.set_joints(data, &seed);
    let target = match orientation {
        Orientation::World => None,
        Orientation::Rows(rotation) => Some(Matrix3::from_row_slice(rotation)),
    };
    let nv = model.nv();
    let mut jp = vec![0.; nv * 3];
    let mut jr = vec![0.; nv * 3];
    for _ in 0..limits.iterations {
        *iterations += 1;
        // The solver reads the site and its Jacobian only: kinematics and
        // com positions.
        model.kinematics(data);
        model.com_pos(data);
        let current = Vector3::from_column_slice(&data.site_xpos()[site * 3..site * 3 + 3]);
        let rotation = &data.site_xmat()[site * 9..site * 9 + 9];
        // The rotation from the site's frame to the target, row-major.
        let error_rotation: [f64; 9] = match &target {
            None => [
                rotation[0],
                rotation[3],
                rotation[6],
                rotation[1],
                rotation[4],
                rotation[7],
                rotation[2],
                rotation[5],
                rotation[8],
            ],
            Some(target) => {
                let product = target * Matrix3::from_row_slice(rotation).transpose();
                let mut row_major = [0.; 9];
                for row in 0..3 {
                    for column in 0..3 {
                        row_major[row * 3 + column] = product[(row, column)];
                    }
                }
                row_major
            }
        };
        let mut quat = mj::mat_to_quat(&error_rotation);
        if quat[0] < 0. {
            for value in &mut quat {
                *value *= -1.;
            }
        }
        let rotation_error = mj::quat_to_velocity(&quat, 1.);
        let delta = position - current;
        let error = Vector6::new(
            delta.x,
            delta.y,
            delta.z,
            rotation_error[0],
            rotation_error[1],
            rotation_error[2],
        );
        if error.norm() < limits.tolerance {
            return Some(arm.joints(data));
        }
        model.jac_site(data, site, &mut jp, &mut jr);
        let mut jacobian = Matrix6::zeros();
        for row in 0..3 {
            for column in 0..6 {
                jacobian[(row, column)] = jp[row * nv + arm.velocities[column]];
                jacobian[(row + 3, column)] = jr[row * nv + arm.velocities[column]];
            }
        }
        let system = jacobian * jacobian.transpose() + Matrix6::identity() * limits.damping;
        let mut update = jacobian.transpose() * system.lu().solve(&error)?;
        update *= (0.05 / update.norm().max(1e-12)).min(1.);
        let qpos = data.qpos_mut();
        for index in 0..6 {
            let angle = &mut qpos[arm.positions[index]];
            *angle = (*angle + update[index])
                .clamp(arm.limits[index].0 + 1e-4, arm.limits[index].1 - 1e-4);
        }
    }
    None
}
