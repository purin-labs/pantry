//! The three MuJoCo worlds: the robot transfer world (`transfer`), the
//! appliance world (`appliance`) and the pour-over station (`station`).
//! Each is built on the safe model and data of `crate::mj`.
use anyhow::{Result, ensure};
use nalgebra::Vector3;
use std::collections::BTreeMap;

use crate::artifact::{ContactPair, ContactShape};
use crate::mj::{Data, Model, Object};

mod appliance;
mod station;
mod transfer;

pub use appliance::{ApplianceEngine, ApplianceModelState, FlexMeshSample};
pub use station::{
    BodyLoad, StationBody, StationContact, StationEngine, StationModelState, StationSite,
};
pub use transfer::{Contact, Engine, OPEN_JAW_M, PARKED_TRAY};

pub type Point = Vector3<f64>;

/// The id of a named object that a world requires. `label` names the world
/// in the error.
fn required(model: &Model, kind: Object, name: &str, label: &str) -> Result<usize> {
    let id = model.id(kind, name)?;
    ensure!(id.is_some(), "Required {label} object missing: {name:?}");
    Ok(id.unwrap_or_default())
}

/// A point of a MuJoCo array of 3-vectors.
fn point(values: &[f64], index: usize) -> Point {
    Point::from_column_slice(&values[index * 3..index * 3 + 3])
}

/// A body's position and quaternion.
fn pose(data: &Data, body: usize) -> [f64; 7] {
    let mut pose = [0.; 7];
    pose[..3].copy_from_slice(&data.xpos()[body * 3..body * 3 + 3]);
    pose[3..].copy_from_slice(&data.xquat()[body * 4..body * 4 + 4]);
    pose
}

/// Writes an integration state, refreshes the derived fields, then writes
/// the state again: the forward changes warm-start fields that the state
/// holds. `check` runs on the written state before the forward.
fn restore_state(
    model: &Model,
    data: &mut Data,
    state: &[f64],
    label: &str,
    check: impl FnOnce(&Data) -> Result<()>,
) -> Result<()> {
    ensure!(
        model.fits_state(state),
        "Incorrect {label}integration-state length"
    );
    ensure!(
        state.iter().all(|value| value.is_finite()),
        "Nonfinite {label}integration state"
    );
    model.set_state(data, state);
    check(data)?;
    model.forward(data);
    model.set_state(data, state);
    Ok(())
}

/// The name of every geometry and its contact shape, read once from the
/// compiled model. Names never change after compilation, so a contact scan
/// borrows them and allocates no name.
struct GeomNames {
    geometry: Vec<String>,
    shapes: Vec<Result<ContactShape, &'static str>>,
}

impl GeomNames {
    fn read(model: &Model) -> Self {
        let mut geometry = Vec::new();
        let mut shapes = Vec::new();
        for id in 0..model.ngeom() {
            let name = model.name(Object::Geom, id).unwrap_or_default().to_owned();
            let body = model.name(Object::Body, model.geom_bodyid()[id] as usize);
            shapes.push(match body {
                None => Err("Contact requires a named body"),
                Some(_) if name.is_empty() => Err("Contact requires a named geometry"),
                Some(body) => Ok(ContactShape {
                    geometry: name.clone(),
                    body: body.to_owned(),
                }),
            });
            geometry.push(name);
        }
        Self { geometry, shapes }
    }

    fn shape(&self, geometry: i32) -> Result<&ContactShape> {
        ensure!(
            geometry >= 0 && (geometry as usize) < self.shapes.len(),
            "Contact requires a geometry"
        );
        self.shapes[geometry as usize]
            .as_ref()
            .map_err(|message| anyhow::anyhow!(*message))
    }

    /// The penetrating contacts of `data`, in MuJoCo's order, by geometry id.
    fn penetrating(data: &Data) -> impl Iterator<Item = (usize, usize)> + '_ {
        data.contacts()
            .iter()
            .filter(|contact| contact.dist < 0.)
            .map(|contact| (contact.geom1 as usize, contact.geom2 as usize))
    }

    /// Pair identity is independent of MuJoCo's contact array ordering.
    /// Forces are normal magnitudes in newtons, summed across the pair's
    /// contact points.
    fn pairs(&self, model: &Model, data: &Data) -> Result<Vec<ContactPair>> {
        // (normal force, penetration) for each pair, ordered by the two shapes.
        let mut pairs: BTreeMap<(&ContactShape, &ContactShape), (f64, f64)> = BTreeMap::new();
        for (index, contact) in data.contacts().iter().enumerate() {
            if contact.dist >= 0. {
                continue;
            }
            let mut first = self.shape(contact.geom1)?;
            let mut second = self.shape(contact.geom2)?;
            if first > second {
                std::mem::swap(&mut first, &mut second);
            }
            let force = model.contact_force(data, index);
            ensure!(
                force[0].is_finite() && contact.dist.is_finite(),
                "Invalid contact evidence"
            );
            let pair = pairs.entry((first, second)).or_insert((0., 0.));
            pair.0 += force[0].max(0.);
            pair.1 = pair.1.max(-contact.dist);
        }
        Ok(pairs
            .into_iter()
            .map(
                |((first, second), (normal_force_n, penetration_m))| ContactPair {
                    first: first.clone(),
                    second: second.clone(),
                    normal_force_n,
                    penetration_m,
                },
            )
            .collect())
    }
}
