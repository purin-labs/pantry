//! The appliance world: one appliance model with no robot, which the
//! appliance controllers drive through named joints, actuators and bodies.
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, path::Path};

use super::restore_state;
use crate::mj::{self, Data, Model, Object, Stages};

pub struct ApplianceEngine {
    model: Model,
    data: Data,
    stages: Stages,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplianceModelState {
    body_mass: Vec<f64>,
    body_inertia: Vec<f64>,
    body_ipos: Vec<f64>,
    dof_damping: Vec<f64>,
    dof_frictionloss: Vec<f64>,
    actuator_gainprm: Vec<f64>,
    actuator_biasprm: Vec<f64>,
    geom_size: Vec<f64>,
    geom_pos: Vec<f64>,
    geom_rgba: Vec<f32>,
    eq_data: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FlexMeshSample {
    pub name: String,
    pub dim: u8,
    pub vertex_count: usize,
    pub vertices: Vec<f64>,
    pub faces: Vec<u16>,
}

impl ApplianceEngine {
    pub fn load(path: &Path) -> Result<Self> {
        let model = Model::load(path, "appliance model")?;
        let mut data = model
            .make_data()
            .context("Cannot allocate appliance state")?;
        model.forward(&mut data);
        Ok(Self {
            model,
            data,
            stages: Stages::default(),
        })
    }

    fn id(&self, kind: Object, name: &str) -> Result<usize> {
        self.model
            .id(kind, name)?
            .with_context(|| format!("Missing appliance element: {name}"))
    }

    pub fn time(&self) -> f64 {
        self.data.time()
    }
    pub fn timestep(&self) -> f64 {
        self.model.timestep()
    }
    pub fn forward(&mut self) {
        self.model.forward(&mut self.data)
    }

    pub fn step(&mut self) -> Result<()> {
        self.model.step(&mut self.data, &mut self.stages);
        ensure!(
            self.data.valid(),
            "Appliance dynamics produced invalid state or a MuJoCo warning"
        );
        self.model
            .forward_after_step(&mut self.data, &mut self.stages);
        Ok(())
    }

    pub fn state(&self) -> Vec<f64> {
        self.model.state(&self.data)
    }

    pub fn restore_state(&mut self, state: &[f64]) -> Result<()> {
        restore_state(&self.model, &mut self.data, state, "appliance ", |_| Ok(()))
    }

    /// A scalar joint's position and velocity.
    pub fn joint(&self, name: &str) -> Result<(f64, f64)> {
        let id = self.id(Object::Joint, name)?;
        ensure!(
            self.model.jnt_type()[id] >= mj::JOINT_SLIDE,
            "Expected a scalar joint"
        );
        let position = self.model.jnt_qposadr()[id] as usize;
        let velocity = self.model.jnt_dofadr()[id] as usize;
        Ok((self.data.qpos()[position], self.data.qvel()[velocity]))
    }

    pub fn damping(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Joint, name)?;
        Ok(self.model.dof_damping()[self.model.jnt_dofadr()[id] as usize])
    }

    pub fn set_damping(&mut self, name: &str, value: f64) -> Result<()> {
        self.stages.clear();
        ensure!(value.is_finite() && value >= 0., "Invalid joint damping");
        let id = self.id(Object::Joint, name)?;
        let dof = self.model.jnt_dofadr()[id] as usize;
        self.model.dof_damping_mut()[dof] = value;
        Ok(())
    }

    pub fn actuator(
        &mut self,
        name: &str,
        target: f64,
        gain: f64,
        position_gain: f64,
        velocity_gain: f64,
    ) -> Result<()> {
        ensure!(
            [target, gain, position_gain, velocity_gain]
                .iter()
                .all(|v| v.is_finite()),
            "Invalid actuator command"
        );
        let id = self.id(Object::Actuator, name)?;
        self.data.ctrl_mut()[id] = target;
        self.model.actuator_gainprm_mut()[id * 10] = gain;
        let bias = self.model.actuator_biasprm_mut();
        bias[id * 10 + 1] = -position_gain;
        bias[id * 10 + 2] = -velocity_gain;
        Ok(())
    }

    pub fn actuator_force(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Actuator, name)?;
        Ok(self.data.actuator_force()[id])
    }

    pub fn joint_bias_force(&self, name: &str) -> Result<f64> {
        let joint = self.id(Object::Joint, name)?;
        ensure!(
            self.model.jnt_type()[joint] == mj::JOINT_HINGE,
            "Bias force requires a hinge joint"
        );
        let dof = self.model.jnt_dofadr()[joint] as usize;
        Ok(self.data.qfrc_bias()[dof])
    }

    pub fn body_pose(&self, name: &str) -> Result<([f64; 3], [f64; 4])> {
        let id = self.id(Object::Body, name)?;
        Ok((
            self.data.xpos()[id * 3..id * 3 + 3].try_into()?,
            self.data.xquat()[id * 4..id * 4 + 4].try_into()?,
        ))
    }

    pub fn site(&self, name: &str) -> Result<[f64; 3]> {
        let id = self.id(Object::Site, name)?;
        Ok(self.data.site_xpos()[id * 3..id * 3 + 3].try_into()?)
    }

    pub fn geom_pose(&self, name: &str) -> Result<([f64; 3], [f64; 4])> {
        let id = self.id(Object::Geom, name)?;
        let rotation: [f64; 9] = self.data.geom_xmat()[id * 9..id * 9 + 9].try_into()?;
        Ok((
            self.data.geom_xpos()[id * 3..id * 3 + 3].try_into()?,
            mj::mat_to_quat(&rotation),
        ))
    }

    pub fn geom_size(&self, name: &str) -> Result<[f64; 3]> {
        let id = self.id(Object::Geom, name)?;
        Ok(self.model.geom_size()[id * 3..id * 3 + 3].try_into()?)
    }

    pub fn body_velocity(&self, name: &str) -> Result<[f64; 6]> {
        let id = self.id(Object::Body, name)?;
        Ok(self.model.body_velocity(&self.data, id))
    }

    pub fn body_mass(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Body, name)?;
        Ok(self.model.body_subtreemass()[id])
    }

    pub fn body_min_inertia(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Body, name)?;
        let inertia = &self.model.body_inertia()[id * 3..id * 3 + 3];
        Ok(inertia.iter().copied().fold(f64::INFINITY, f64::min))
    }

    pub fn apply_force(&mut self, name: &str, force: [f64; 6]) -> Result<()> {
        ensure!(force.iter().all(|v| v.is_finite()), "Invalid body force");
        let id = self.id(Object::Body, name)?;
        self.data.xfrc_applied_mut()[id * 6..id * 6 + 6].copy_from_slice(&force);
        Ok(())
    }

    pub fn support_force(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Geom, name)? as i32;
        let mut total = 0.;
        for (index, contact) in self.data.contacts().iter().enumerate() {
            if contact.geom1 != id && contact.geom2 != id {
                continue;
            }
            let force = self.model.contact_force(&self.data, index);
            let vertical = contact.frame[2] * force[0]
                + contact.frame[5] * force[1]
                + contact.frame[8] * force[2];
            total += vertical * if contact.geom2 == id { 1. } else { -1. };
        }
        Ok(total)
    }

    pub fn coupling(&self, name: &str) -> Result<bool> {
        let id = self.id(Object::Equality, name)?;
        Ok(self.data.eq_active()[id])
    }

    pub fn set_coupling(&mut self, name: &str, active: bool) -> Result<()> {
        let id = self.id(Object::Equality, name)?;
        self.data.eq_active_mut()[id] = active;
        Ok(())
    }

    pub fn set_payload(
        &mut self,
        mass: f64,
        radius: f64,
        bottom: f64,
        volume_l: f64,
    ) -> Result<()> {
        self.stages.clear();
        ensure!(
            [mass, radius, bottom, volume_l]
                .iter()
                .all(|v| v.is_finite())
                && mass >= 0.
                && radius > 0.
                && volume_l >= 0.,
            "Invalid ingredient payload"
        );
        let body = self.id(Object::Body, "ingredient_payload")?;
        let geom = self.id(Object::Geom, "ingredient_surface")?;
        let state = self.state();
        let height = volume_l / 1000. / (std::f64::consts::PI * radius * radius);
        let inertial_mass = mass.max(1e-9);
        let model = &mut self.model;
        model.body_mass_mut()[body] = inertial_mass;
        let inertia = &mut model.body_inertia_mut()[body * 3..body * 3 + 3];
        inertia[0] = inertial_mass * (3. * radius * radius + height * height) / 12.;
        inertia[1] = inertia[0];
        inertia[2] = inertial_mass * radius * radius / 2.;
        model.body_ipos_mut()[body * 3 + 2] = bottom + height / 2.;
        model.geom_pos_mut()[geom * 3 + 2] = bottom + height;
        model.geom_rgba_mut()[geom * 4 + 3] = if mass > 0. { 0.8 } else { 0. };
        model.set_const(&mut self.data);
        self.restore_state(&state)
    }

    /// Effective cup mass and inertia include its contents inside the cup envelope.
    pub fn set_cup_contents(&mut self, name: &str, liquid_g: f64, radius: f64) -> Result<()> {
        ensure!(
            liquid_g.is_finite() && (0. ..=250.).contains(&liquid_g),
            "Invalid cup contents"
        );
        let id = self.id(Object::Body, name)?;
        let mass = 0.2 + liquid_g / 1000.;
        if (self.model.body_mass()[id] - mass).abs() < 1e-12 {
            return Ok(());
        }
        self.stages.clear();
        let state = self.state();
        let model = &mut self.model;
        model.body_mass_mut()[id] = mass;
        let inertia = &mut model.body_inertia_mut()[id * 3..id * 3 + 3];
        inertia[0] = mass * (3. * radius * radius + 0.07_f64.powi(2)) / 12.;
        inertia[1] = inertia[0];
        inertia[2] = mass * radius * radius / 2.;
        model.set_const(&mut self.data);
        self.restore_state(&state)
    }

    pub fn model_state(&self) -> ApplianceModelState {
        let model = &self.model;
        ApplianceModelState {
            body_mass: model.body_mass().to_vec(),
            body_inertia: model.body_inertia().to_vec(),
            body_ipos: model.body_ipos().to_vec(),
            dof_damping: model.dof_damping().to_vec(),
            dof_frictionloss: model.dof_frictionloss().to_vec(),
            actuator_gainprm: model.actuator_gainprm().to_vec(),
            actuator_biasprm: model.actuator_biasprm().to_vec(),
            geom_size: model.geom_size().to_vec(),
            geom_pos: model.geom_pos().to_vec(),
            geom_rgba: model.geom_rgba().to_vec(),
            eq_data: model.eq_data().to_vec(),
        }
    }

    pub fn restore_model(&mut self, saved: &ApplianceModelState) -> Result<()> {
        self.stages.clear();
        let expected = self.model_state();
        macro_rules! check {
            ($field:ident) => {
                ensure!(
                    saved.$field.len() == expected.$field.len()
                        && saved.$field.iter().all(|v| v.is_finite()),
                    "Invalid appliance parameter {}",
                    stringify!($field)
                );
            };
        }
        check!(body_mass);
        check!(body_inertia);
        check!(body_ipos);
        check!(dof_damping);
        check!(dof_frictionloss);
        check!(actuator_gainprm);
        check!(actuator_biasprm);
        check!(geom_size);
        check!(geom_pos);
        check!(geom_rgba);
        check!(eq_data);
        ensure!(
            saved
                .body_mass
                .iter()
                .chain(saved.body_inertia.iter())
                .chain(saved.dof_damping.iter())
                .chain(saved.dof_frictionloss.iter())
                .chain(saved.geom_size.iter())
                .all(|v| *v >= 0.),
            "Physical parameters must be nonnegative"
        );
        ensure!(
            saved.geom_rgba.iter().all(|v| (0. ..=1.).contains(v)),
            "Colors must be within 0–1"
        );
        let model = &mut self.model;
        model.body_mass_mut().copy_from_slice(&saved.body_mass);
        model
            .body_inertia_mut()
            .copy_from_slice(&saved.body_inertia);
        model.body_ipos_mut().copy_from_slice(&saved.body_ipos);
        model.dof_damping_mut().copy_from_slice(&saved.dof_damping);
        model
            .dof_frictionloss_mut()
            .copy_from_slice(&saved.dof_frictionloss);
        model
            .actuator_gainprm_mut()
            .copy_from_slice(&saved.actuator_gainprm);
        model
            .actuator_biasprm_mut()
            .copy_from_slice(&saved.actuator_biasprm);
        model.geom_size_mut().copy_from_slice(&saved.geom_size);
        model.geom_pos_mut().copy_from_slice(&saved.geom_pos);
        model.geom_rgba_mut().copy_from_slice(&saved.geom_rgba);
        model.eq_data_mut().copy_from_slice(&saved.eq_data);
        model.set_const(&mut self.data);
        Ok(())
    }

    pub fn contact_force(&self, first: &str, second: &str) -> Result<f64> {
        let first = self.id(Object::Geom, first)? as i32;
        let second = self.id(Object::Geom, second)? as i32;
        let mut total = 0.;
        for (index, contact) in self.data.contacts().iter().enumerate() {
            if (contact.geom1 == first && contact.geom2 == second)
                || (contact.geom1 == second && contact.geom2 == first)
            {
                total += self.model.contact_force(&self.data, index)[0].max(0.);
            }
        }
        Ok(total)
    }

    pub fn stiffness(&self, name: &str) -> Result<f64> {
        let id = self.id(Object::Joint, name)?;
        Ok(self.model.jnt_stiffness()[id])
    }

    pub fn control(&mut self, name: &str, target: f64) -> Result<()> {
        ensure!(target.is_finite(), "Actuator command must be finite");
        let id = self.id(Object::Actuator, name)?;
        self.data.ctrl_mut()[id] = target;
        Ok(())
    }

    pub fn collision_bounds(&self, name: &str) -> Result<([f64; 3], [f64; 3])> {
        let body = self.id(Object::Body, name)? as i32;
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        let (model, data) = (&self.model, &self.data);
        for id in 0..model.ngeom() {
            if model.geom_bodyid()[id] != body || model.geom_contype()[id] == 0 {
                continue;
            }
            let bounds = &model.geom_aabb()[id * 6..id * 6 + 6];
            let rotation = &data.geom_xmat()[id * 9..id * 9 + 9];
            let position = &data.geom_xpos()[id * 3..id * 3 + 3];
            for axis in 0..3 {
                let mut center = position[axis];
                let mut extent = 0.;
                for column in 0..3 {
                    center += rotation[axis * 3 + column] * bounds[column];
                    extent += rotation[axis * 3 + column].abs() * bounds[column + 3];
                }
                low[axis] = low[axis].min(center - extent);
                high[axis] = high[axis].max(center + extent);
            }
        }
        ensure!(
            low.iter().chain(high.iter()).all(|value| value.is_finite()),
            "Body has no collision geometry"
        );
        Ok((low, high))
    }

    pub fn body_poses(&self) -> Result<BTreeMap<String, [f64; 7]>> {
        let mut result = BTreeMap::new();
        for id in 1..self.model.nbody() {
            if self.model.body_jntnum()[id] == 0 {
                continue;
            }
            let Some(name) = self.model.name(Object::Body, id) else {
                continue;
            };
            if name.starts_with("live_") || name == "ingredient_payload" {
                continue;
            }
            let (position, quaternion) = self.body_pose(name)?;
            result.insert(
                name.to_owned(),
                [
                    position[0],
                    position[1],
                    position[2],
                    quaternion[0],
                    quaternion[1],
                    quaternion[2],
                    quaternion[3],
                ],
            );
        }
        Ok(result)
    }

    /// The vertex range of a flex in the flex vertex arrays.
    fn flex_range(&self, flex: usize) -> std::ops::Range<usize> {
        let start = self.model.flex_vertadr()[flex] as usize;
        start..start + self.model.flex_vertnum()[flex] as usize
    }

    pub fn flex_vertices(&self, name: &str) -> Result<Vec<[f64; 3]>> {
        let flex = self.id(Object::Flex, name)?;
        let positions = self.data.flexvert_xpos();
        Ok(self
            .flex_range(flex)
            .map(|vertex| positions[vertex * 3..vertex * 3 + 3].try_into().unwrap())
            .collect())
    }

    pub fn reset_flex(&mut self, name: &str) -> Result<()> {
        let flex = self.id(Object::Flex, name)?;
        let model = &self.model;
        for vertex in self.flex_range(flex) {
            let body_id = model.flex_vertbodyid()[vertex];
            if body_id <= 0 {
                continue;
            }
            let body = body_id as usize;
            let jnt_adr = model.body_jntadr()[body];
            let jnt_num = model.body_jntnum()[body];
            if jnt_adr < 0 || jnt_num <= 0 {
                continue;
            }
            for jnt in jnt_adr as usize..jnt_adr as usize + jnt_num as usize {
                let (qlen, dlen) = match model.jnt_type()[jnt] {
                    mj::JOINT_FREE => (7, 6),
                    mj::JOINT_BALL => (4, 3),
                    _ => (1, 1),
                };
                let qadr = model.jnt_qposadr()[jnt] as usize;
                let dadr = model.jnt_dofadr()[jnt] as usize;
                self.data.qpos_mut()[qadr..qadr + qlen]
                    .copy_from_slice(&model.qpos0()[qadr..qadr + qlen]);
                self.data.qvel_mut()[dadr..dadr + dlen].fill(0.);
            }
        }
        self.model.forward(&mut self.data);
        Ok(())
    }

    pub fn flex_meshes(&self) -> Result<Vec<FlexMeshSample>> {
        let mut meshes = Vec::new();
        let model = &self.model;
        for flex in 0..model.nflex() {
            let dim = model.flex_dim()[flex];
            if dim != 2 && dim != 3 {
                continue;
            }
            let name = match model.name(Object::Flex, flex) {
                Some(name) => name.to_owned(),
                None => format!("flex_{flex}"),
            };
            let range = self.flex_range(flex);
            let vert_num = range.len();
            let elem_num = model.flex_elemnum()[flex] as usize;
            let elem_data_adr = model.flex_elemdataadr()[flex] as usize;
            let mut vertices = Vec::with_capacity(vert_num * 3);
            for &coord in &self.data.flexvert_xpos()[range.start * 3..range.end * 3] {
                ensure!(coord.is_finite(), "Nonfinite flex vertex coordinate");
                vertices.push((coord * 100_000.).round() / 100_000.);
            }
            let mut faces = Vec::new();
            if dim == 2 {
                faces.reserve(elem_num * 3);
                for &idx in &model.flex_elem()[elem_data_adr..elem_data_adr + elem_num * 3] {
                    faces.push(u16::try_from(idx).context("Flex vertex index overflow")?);
                }
            } else {
                let elems = &model.flex_elem()[elem_data_adr..elem_data_adr + elem_num * 4];
                let mut boundary = BTreeMap::<[u16; 3], Option<[u16; 3]>>::new();
                let pos_at = |idx: u16| -> [f64; 3] {
                    let base = (idx as usize) * 3;
                    [vertices[base], vertices[base + 1], vertices[base + 2]]
                };
                for tet in elems.chunks_exact(4) {
                    let a = u16::try_from(tet[0]).context("Flex vertex index overflow")?;
                    let b = u16::try_from(tet[1]).context("Flex vertex index overflow")?;
                    let c = u16::try_from(tet[2]).context("Flex vertex index overflow")?;
                    let d = u16::try_from(tet[3]).context("Flex vertex index overflow")?;
                    for (i0, i1, i2, opp) in
                        [(a, b, c, d), (a, d, b, c), (b, d, c, a), (c, d, a, b)]
                    {
                        let mut key = [i0, i1, i2];
                        key.sort_unstable();
                        if let Some(slot) = boundary.get_mut(&key) {
                            *slot = None;
                        } else {
                            let p0 = pos_at(i0);
                            let p1 = pos_at(i1);
                            let p2 = pos_at(i2);
                            let po = pos_at(opp);
                            let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
                            let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
                            let n = [
                                e1[1] * e2[2] - e1[2] * e2[1],
                                e1[2] * e2[0] - e1[0] * e2[2],
                                e1[0] * e2[1] - e1[1] * e2[0],
                            ];
                            let outward = [p0[0] - po[0], p0[1] - po[1], p0[2] - po[2]];
                            let dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
                            let tri = if dot < 0.0 {
                                [i0, i2, i1]
                            } else {
                                [i0, i1, i2]
                            };
                            boundary.insert(key, Some(tri));
                        }
                    }
                }
                faces.reserve(boundary.len() * 3);
                for tri in boundary.values().flatten() {
                    faces.extend_from_slice(tri);
                }
            }
            meshes.push(FlexMeshSample {
                name,
                dim: dim as u8,
                vertex_count: vert_num,
                vertices,
                faces,
            });
        }
        Ok(meshes)
    }
}
