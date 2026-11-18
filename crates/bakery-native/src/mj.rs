//! The only MuJoCo boundary with raw pointers. `Model` and `Data` own their
//! MuJoCo allocations and free them on drop. Every array crosses as a slice
//! with its MuJoCo length, and every call that takes a model and a data
//! checks that the data belongs to that model. The rest of the crate uses no
//! `unsafe` (the crate root denies it).
use anyhow::{Context, Result, bail, ensure};
use std::{
    ffi::{CStr, CString},
    marker::PhantomData,
    path::Path,
    ptr, slice,
    sync::atomic::{AtomicU64, Ordering},
};

#[allow(warnings, clippy::all)]
mod ffi {
    include!(concat!(env!("OUT_DIR"), "/mujoco.rs"));
}

/// One contact of MuJoCo's contact array, read only.
pub type Contact = ffi::mjContact;

/// The kinds of named model objects that the engines look up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Object {
    Body,
    Joint,
    Geom,
    Site,
    Actuator,
    Equality,
    Flex,
}

impl Object {
    fn raw(self) -> ffi::mjtObj {
        match self {
            Self::Body => ffi::mjtObj_mjOBJ_BODY,
            Self::Joint => ffi::mjtObj_mjOBJ_JOINT,
            Self::Geom => ffi::mjtObj_mjOBJ_GEOM,
            Self::Site => ffi::mjtObj_mjOBJ_SITE,
            Self::Actuator => ffi::mjtObj_mjOBJ_ACTUATOR,
            Self::Equality => ffi::mjtObj_mjOBJ_EQUALITY,
            Self::Flex => ffi::mjtObj_mjOBJ_FLEX,
        }
    }
}

/// MuJoCo joint types, as `jnt_type` holds them.
pub const JOINT_FREE: i32 = ffi::mjtJoint_mjJNT_FREE as i32;
pub const JOINT_BALL: i32 = ffi::mjtJoint_mjJNT_BALL as i32;
pub const JOINT_SLIDE: i32 = ffi::mjtJoint_mjJNT_SLIDE as i32;
pub const JOINT_HINGE: i32 = ffi::mjtJoint_mjJNT_HINGE as i32;

/// The engines are built and pinned against MuJoCo 4.0.0.
pub fn require_version() -> Result<()> {
    ensure!(
        unsafe { ffi::mj_version() } == 4000000 && ffi::mjVERSION_HEADER == 4000000,
        "Runner requires MuJoCo 4.0.0 headers and library"
    );
    Ok(())
}

/// A slice of a MuJoCo array. MuJoCo leaves an empty array as null.
///
/// # Safety
/// `pointer` must address `length` initialized values that live for `'a`.
unsafe fn view<'a, T>(pointer: *const T, length: usize) -> &'a [T] {
    if length == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(pointer, length) }
    }
}

/// # Safety
/// As `view`, and no other reference to the values may exist for `'a`.
unsafe fn view_mut<'a, T>(pointer: *mut T, length: usize) -> &'a mut [T] {
    if length == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(pointer, length) }
    }
}

fn size(value: i64) -> usize {
    usize::try_from(value).expect("MuJoCo sizes are nonnegative")
}

fn error_text(buffer: &[std::ffi::c_char]) -> String {
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

fn c_path(path: &Path, what: &str) -> Result<CString> {
    Ok(CString::new(
        path.to_str()
            .with_context(|| format!("Non-UTF8 {what} path"))?,
    )?)
}

static NEXT_MODEL: AtomicU64 = AtomicU64::new(1);

/// A compiled MuJoCo model.
pub struct Model {
    raw: *mut ffi::mjModel,
    /// Each data records the model it was made for.
    id: u64,
}

impl Drop for Model {
    fn drop(&mut self) {
        unsafe { ffi::mj_deleteModel(self.raw) }
    }
}

/// The values of one model array: its name, element type and length.
macro_rules! model_arrays {
    ($($name:ident $(, $mutable:ident)?: $ty:ty = |$model:ident| $length:expr;)*) => {
        impl Model {
            $(
                pub fn $name(&self) -> &[$ty] {
                    let $model = self.get();
                    unsafe { view($model.$name, $length) }
                }
                $(
                    pub fn $mutable(&mut self) -> &mut [$ty] {
                        let $model = self.get();
                        let length = $length;
                        unsafe { view_mut((*self.raw).$name, length) }
                    }
                )?
            )*
        }
    };
}

model_arrays! {
    qpos0: f64 = |m| size(m.nq);
    body_jntnum: i32 = |m| size(m.nbody);
    body_jntadr: i32 = |m| size(m.nbody);
    body_mass, body_mass_mut: f64 = |m| size(m.nbody);
    body_subtreemass: f64 = |m| size(m.nbody);
    body_inertia, body_inertia_mut: f64 = |m| size(m.nbody) * 3;
    body_ipos, body_ipos_mut: f64 = |m| size(m.nbody) * 3;
    jnt_type: i32 = |m| size(m.njnt);
    jnt_qposadr: i32 = |m| size(m.njnt);
    jnt_dofadr: i32 = |m| size(m.njnt);
    jnt_range: f64 = |m| size(m.njnt) * 2;
    jnt_stiffness: f64 = |m| size(m.njnt);
    dof_damping, dof_damping_mut: f64 = |m| size(m.nv);
    dof_frictionloss, dof_frictionloss_mut: f64 = |m| size(m.nv);
    geom_bodyid: i32 = |m| size(m.ngeom);
    geom_contype, geom_contype_mut: i32 = |m| size(m.ngeom);
    geom_conaffinity, geom_conaffinity_mut: i32 = |m| size(m.ngeom);
    geom_size, geom_size_mut: f64 = |m| size(m.ngeom) * 3;
    geom_pos, geom_pos_mut: f64 = |m| size(m.ngeom) * 3;
    geom_rgba, geom_rgba_mut: f32 = |m| size(m.ngeom) * 4;
    geom_aabb: f64 = |m| size(m.ngeom) * 6;
    actuator_forcerange, actuator_forcerange_mut: f64 = |m| size(m.nu) * 2;
    actuator_gainprm, actuator_gainprm_mut: f64 = |m| size(m.nu) * 10;
    actuator_biasprm, actuator_biasprm_mut: f64 = |m| size(m.nu) * 10;
    eq_data, eq_data_mut: f64 = |m| size(m.neq) * 11;
    flex_dim: i32 = |m| size(m.nflex);
    flex_vertadr: i32 = |m| size(m.nflex);
    flex_vertnum: i32 = |m| size(m.nflex);
    flex_elemnum: i32 = |m| size(m.nflex);
    flex_elemdataadr: i32 = |m| size(m.nflex);
    flex_vertbodyid: i32 = |m| size(m.nflexvert);
    flex_elem: i32 = |m| size(m.nflexelemdata);
}

impl Model {
    fn adopt(raw: *mut ffi::mjModel) -> Self {
        Self {
            raw,
            id: NEXT_MODEL.fetch_add(1, Ordering::Relaxed),
        }
    }

    fn get(&self) -> &ffi::mjModel {
        unsafe { &*self.raw }
    }

    /// Loads and compiles an MJCF file. `what` names the model in errors.
    pub fn load(path: &Path, what: &str) -> Result<Self> {
        require_version()?;
        crate::assets::require(path)?;
        let path = c_path(path, what)?;
        let mut error = [0 as std::ffi::c_char; 1024];
        let raw = unsafe {
            ffi::mj_loadXML(
                path.as_ptr(),
                ptr::null(),
                error.as_mut_ptr(),
                error.len() as i32,
            )
        };
        ensure!(!raw.is_null(), "Cannot load {what}: {}", error_text(&error));
        Ok(Self::adopt(raw))
    }

    /// A new data for this model, at the model's initial state.
    pub fn make_data(&self) -> Result<Data> {
        let raw = unsafe { ffi::mj_makeData(self.raw) };
        ensure!(!raw.is_null(), "Cannot allocate MuJoCo data");
        let m = self.get();
        Ok(Data {
            raw,
            model: self.id,
            nq: size(m.nq),
            nv: size(m.nv),
            nu: size(m.nu),
            na: size(m.na),
            nbody: size(m.nbody),
            ngeom: size(m.ngeom),
            nsite: size(m.nsite),
            neq: size(m.neq),
            nmocap: size(m.nmocap),
            nflexvert: size(m.nflexvert),
        })
    }

    fn check(&self, data: &Data) {
        assert_eq!(data.model, self.id, "MuJoCo data belongs to another model");
    }

    pub fn nq(&self) -> usize {
        size(self.get().nq)
    }
    pub fn nv(&self) -> usize {
        size(self.get().nv)
    }
    pub fn nu(&self) -> usize {
        size(self.get().nu)
    }
    pub fn nbody(&self) -> usize {
        size(self.get().nbody)
    }
    pub fn ngeom(&self) -> usize {
        size(self.get().ngeom)
    }
    pub fn nflex(&self) -> usize {
        size(self.get().nflex)
    }

    pub fn timestep(&self) -> f64 {
        self.get().opt.timestep
    }
    pub fn set_timestep(&mut self, timestep: f64) {
        unsafe { (*self.raw).opt.timestep = timestep }
    }
    pub fn gravity(&self) -> [f64; 3] {
        self.get().opt.gravity
    }

    /// The id of a named object, if the model has it.
    pub fn id(&self, kind: Object, name: &str) -> Result<Option<usize>> {
        let name = CString::new(name)?;
        let id = unsafe { ffi::mj_name2id(self.raw, kind.raw() as i32, name.as_ptr()) };
        Ok(usize::try_from(id).ok())
    }

    /// The name of an object, if it has one.
    pub fn name(&self, kind: Object, id: usize) -> Option<&str> {
        let name = unsafe { ffi::mj_id2name(self.raw, kind.raw() as i32, id as i32) };
        if name.is_null() {
            return None;
        }
        // Names live as long as the model; MJCF names are UTF-8.
        unsafe { CStr::from_ptr(name) }.to_str().ok()
    }

    pub fn forward(&self, data: &mut Data) {
        self.check(data);
        unsafe { ffi::mj_forward(self.raw, data.raw) }
    }
    pub fn kinematics(&self, data: &mut Data) {
        self.check(data);
        unsafe { ffi::mj_kinematics(self.raw, data.raw) }
    }
    pub fn com_pos(&self, data: &mut Data) {
        self.check(data);
        unsafe { ffi::mj_comPos(self.raw, data.raw) }
    }
    pub fn reset(&self, data: &mut Data) {
        self.check(data);
        unsafe { ffi::mj_resetData(self.raw, data.raw) }
    }
    /// Recomputes the constants that depend on masses and other parameters.
    pub fn set_const(&mut self, data: &mut Data) {
        self.check(data);
        unsafe { ffi::mj_setConst(self.raw, data.raw) }
    }

    fn integration_size(&self) -> usize {
        let signature = ffi::mjtState_mjSTATE_INTEGRATION as i32;
        unsafe { ffi::mj_stateSize(self.raw, signature) as usize }
    }

    /// The integration state of `data`.
    pub fn state(&self, data: &Data) -> Vec<f64> {
        self.check(data);
        let signature = ffi::mjtState_mjSTATE_INTEGRATION as i32;
        let mut state = vec![0.; self.integration_size()];
        unsafe { ffi::mj_getState(self.raw, data.raw, state.as_mut_ptr(), signature) };
        state
    }

    /// Whether `state` has the length of an integration state of this model.
    pub fn fits_state(&self, state: &[f64]) -> bool {
        state.len() == self.integration_size()
    }

    /// Writes an integration state. Its length must fit (`fits_state`).
    pub fn set_state(&self, data: &mut Data, state: &[f64]) {
        self.check(data);
        assert!(self.fits_state(state), "Incorrect integration-state length");
        let signature = ffi::mjtState_mjSTATE_INTEGRATION as i32;
        unsafe { ffi::mj_setState(self.raw, data.raw, state.as_ptr(), signature) }
    }

    /// The translational and rotational Jacobians of a site, each 3 × nv.
    pub fn jac_site(&self, data: &Data, site: usize, position: &mut [f64], rotation: &mut [f64]) {
        self.check(data);
        let length = 3 * self.nv();
        assert!(position.len() == length && rotation.len() == length);
        assert!(site < data.nsite);
        unsafe {
            ffi::mj_jacSite(
                self.raw,
                data.raw,
                position.as_mut_ptr(),
                rotation.as_mut_ptr(),
                site as i32,
            )
        }
    }

    /// The translational Jacobian (3 × nv) of a world point fixed to `body`.
    pub fn jac_point(&self, data: &Data, point: &[f64; 3], body: usize, position: &mut [f64]) {
        self.check(data);
        assert!(position.len() == 3 * self.nv() && body < data.nbody);
        unsafe {
            ffi::mj_jac(
                self.raw,
                data.raw,
                position.as_mut_ptr(),
                ptr::null_mut(),
                point.as_ptr(),
                body as i32,
            )
        }
    }

    /// A body's spatial velocity (rotation, then translation) in world axes.
    pub fn body_velocity(&self, data: &Data, body: usize) -> [f64; 6] {
        self.check(data);
        assert!(body < data.nbody);
        let mut velocity = [0.; 6];
        unsafe {
            ffi::mj_objectVelocity(
                self.raw,
                data.raw,
                ffi::mjtObj_mjOBJ_BODY as i32,
                body as i32,
                velocity.as_mut_ptr(),
                0,
            )
        };
        velocity
    }

    /// The force of contact `index`, in the contact frame.
    pub fn contact_force(&self, data: &Data, index: usize) -> [f64; 6] {
        self.check(data);
        assert!(index < data.contacts().len());
        let mut force = [0.; 6];
        unsafe { ffi::mj_contactForce(self.raw, data.raw, index as i32, force.as_mut_ptr()) };
        force
    }

    /// `mj_step`, without the position and velocity stages when `stages`
    /// says that the last forward computed them at this state. The calls are
    /// the calls of `mj_step` in MuJoCo 4.0.0 (`engine_forward.c`), with
    /// `mj_forwardSkip(.., mjSTAGE_VEL, ..)` in place of `mj_forward`.
    #[inline(never)]
    pub fn step(&self, data: &mut Data, stages: &mut Stages) {
        self.check(data);
        let options = &self.get().opt;
        let integrator = options.integrator as u32;
        let reusable = stages.current(data)
            && (integrator == ffi::mjtIntegrator_mjINT_IMPLICITFAST
                || integrator == ffi::mjtIntegrator_mjINT_IMPLICIT
                || integrator == ffi::mjtIntegrator_mjINT_EULER)
            && options.enableflags
                & (ffi::mjtEnableBit_mjENBL_FWDINV | ffi::mjtEnableBit_mjENBL_SLEEP) as i32
                == 0;
        stages.clear();
        let (model, data) = (self.raw, data.raw);
        unsafe {
            if !reusable {
                ffi::mj_step(model, data);
                return;
            }
            ffi::mj_checkPos(model, data);
            ffi::mj_checkVel(model, data);
            ffi::mj_forwardSkip(model, data, ffi::mjtStage_mjSTAGE_VEL as i32, 0);
            ffi::mj_checkAcc(model, data);
            if integrator == ffi::mjtIntegrator_mjINT_EULER {
                ffi::mj_Euler(model, data);
            } else {
                ffi::mj_implicit(model, data);
            }
        }
    }

    /// The full forward after a step, recorded in `stages` so that the next
    /// step can reuse its position and velocity stages.
    pub fn forward_after_step(&self, data: &mut Data, stages: &mut Stages) {
        self.forward(data);
        stages.capture(data);
    }
}

/// MuJoCo's simulation state for one model.
pub struct Data {
    raw: *mut ffi::mjData,
    model: u64,
    nq: usize,
    nv: usize,
    nu: usize,
    na: usize,
    nbody: usize,
    ngeom: usize,
    nsite: usize,
    neq: usize,
    nmocap: usize,
    nflexvert: usize,
}

impl Drop for Data {
    fn drop(&mut self) {
        unsafe { ffi::mj_deleteData(self.raw) }
    }
}

macro_rules! data_arrays {
    ($($name:ident $(, $mutable:ident)?: $ty:ty = |$data:ident| $length:expr;)*) => {
        impl Data {
            $(
                pub fn $name(&self) -> &[$ty] {
                    let $data = self;
                    unsafe { view((*self.raw).$name, $length) }
                }
                $(
                    pub fn $mutable(&mut self) -> &mut [$ty] {
                        let $data = &*self;
                        let length = $length;
                        unsafe { view_mut((*self.raw).$name, length) }
                    }
                )?
            )*
        }
    };
}

data_arrays! {
    qpos, qpos_mut: f64 = |d| d.nq;
    qvel, qvel_mut: f64 = |d| d.nv;
    act: f64 = |d| d.na;
    ctrl, ctrl_mut: f64 = |d| d.nu;
    mocap_pos: f64 = |d| d.nmocap * 3;
    mocap_quat: f64 = |d| d.nmocap * 4;
    eq_active, eq_active_mut: bool = |d| d.neq;
    xpos: f64 = |d| d.nbody * 3;
    xquat: f64 = |d| d.nbody * 4;
    xmat: f64 = |d| d.nbody * 9;
    xipos: f64 = |d| d.nbody * 3;
    subtree_com: f64 = |d| d.nbody * 3;
    xfrc_applied, xfrc_applied_mut: f64 = |d| d.nbody * 6;
    site_xpos: f64 = |d| d.nsite * 3;
    site_xmat: f64 = |d| d.nsite * 9;
    geom_xpos: f64 = |d| d.ngeom * 3;
    geom_xmat: f64 = |d| d.ngeom * 9;
    qfrc_bias: f64 = |d| d.nv;
    actuator_force: f64 = |d| d.nu;
    flexvert_xpos: f64 = |d| d.nflexvert * 3;
}

impl Data {
    pub fn time(&self) -> f64 {
        unsafe { (*self.raw).time }
    }

    /// The contacts of the last collision pass, in MuJoCo's order.
    pub fn contacts(&self) -> &[Contact] {
        unsafe {
            let data = &*self.raw;
            view(data.contact, data.ncon as usize)
        }
    }

    /// No MuJoCo warning since this data was made.
    pub fn warning_free(&self) -> bool {
        unsafe {
            (*self.raw)
                .warning
                .iter()
                .all(|warning| warning.number == 0)
        }
    }

    /// Finite positions and velocities, and no MuJoCo warning.
    pub fn valid(&self) -> bool {
        self.qpos().iter().all(|v| v.is_finite())
            && self.qvel().iter().all(|v| v.is_finite())
            && self.warning_free()
    }
}

/// The inputs of MuJoCo's position and velocity stages, as the last full
/// `mj_forward` after a step saw them. Each step ends with that forward, and
/// the next `mj_step` would compute the same two stages again at the same
/// state. While these inputs and the model are unchanged, the next step
/// reuses them and computes only the acceleration stage. A method that
/// writes the model clears them.
#[derive(Default)]
pub struct Stages {
    valid: bool,
    /// time, qpos, qvel, act, mocap_pos and mocap_quat, as bits.
    state: Vec<u64>,
    eq_active: Vec<bool>,
}

impl Stages {
    fn read(data: &Data, state: &mut Vec<u64>) {
        state.clear();
        state.push(data.time().to_bits());
        for values in [
            data.qpos(),
            data.qvel(),
            data.act(),
            data.mocap_pos(),
            data.mocap_quat(),
        ] {
            state.extend(values.iter().map(|value| value.to_bits()));
        }
    }

    fn capture(&mut self, data: &Data) {
        Self::read(data, &mut self.state);
        self.eq_active.clear();
        self.eq_active.extend_from_slice(data.eq_active());
        self.valid = true;
    }

    pub fn clear(&mut self) {
        self.valid = false;
    }

    fn current(&self, data: &Data) -> bool {
        if !self.valid {
            return false;
        }
        let mut state = Vec::with_capacity(self.state.len());
        Self::read(data, &mut state);
        state == self.state && data.eq_active() == self.eq_active.as_slice()
    }
}

/// The quaternion of a row-major rotation matrix (`mju_mat2Quat`).
pub fn mat_to_quat(matrix: &[f64; 9]) -> [f64; 4] {
    let mut quat = [0.; 4];
    unsafe { ffi::mju_mat2Quat(quat.as_mut_ptr(), matrix.as_ptr()) };
    quat
}

/// The angular velocity that turns the identity into `quat` in `dt`
/// (`mju_quat2Vel`).
pub fn quat_to_velocity(quat: &[f64; 4], dt: f64) -> [f64; 3] {
    let mut velocity = [0.; 3];
    unsafe { ffi::mju_quat2Vel(velocity.as_mut_ptr(), quat.as_ptr(), dt) };
    velocity
}

/// An MJCF model before compilation, for edits of named elements.
pub struct Spec {
    raw: *mut ffi::mjSpec,
}

impl Drop for Spec {
    fn drop(&mut self) {
        unsafe { ffi::mj_deleteSpec(self.raw) }
    }
}

/// A geometry of a `Spec`, borrowed for an edit.
pub struct SpecGeom<'a> {
    raw: *mut ffi::mjsGeom,
    spec: PhantomData<&'a mut Spec>,
}

impl SpecGeom<'_> {
    fn get(&mut self) -> &mut ffi::mjsGeom {
        unsafe { &mut *self.raw }
    }
    pub fn set_mass(&mut self, mass: f64) {
        self.get().mass = mass;
    }
    pub fn set_collisions(&mut self, contype: i32, conaffinity: i32) {
        let geom = self.get();
        geom.contype = contype;
        geom.conaffinity = conaffinity;
    }
    pub fn position(&mut self) -> &mut [f64; 3] {
        &mut self.get().pos
    }
    /// The contact parameters of a geometry that takes priority in its pairs.
    pub fn set_contact(&mut self, priority: i32, solref: [f64; 2], solimp: [f64; 5]) {
        let geom = self.get();
        geom.priority = priority;
        geom.solref = solref;
        geom.solimp = solimp;
    }
}

impl Spec {
    pub fn parse(path: &Path) -> Result<Self> {
        require_version()?;
        crate::assets::require(path)?;
        let path = c_path(path, "model")?;
        let mut error = [0 as std::ffi::c_char; 1024];
        let raw = unsafe {
            ffi::mj_parseXML(
                path.as_ptr(),
                ptr::null(),
                error.as_mut_ptr(),
                error.len() as i32,
            )
        };
        ensure!(
            !raw.is_null(),
            "Cannot parse MuJoCo model: {}",
            error_text(&error)
        );
        Ok(Self { raw })
    }

    fn body(&self, name: &CStr) -> Option<*mut ffi::mjsBody> {
        let body = unsafe { ffi::mjs_findBody(self.raw, name.as_ptr()) };
        (!body.is_null()).then_some(body)
    }

    /// The position of a named body in its parent's frame.
    pub fn body_position(&mut self, name: &CStr) -> Option<&mut [f64; 3]> {
        self.body(name).map(|body| unsafe { &mut (*body).pos })
    }

    pub fn geom(&mut self, name: &CStr) -> Option<SpecGeom<'_>> {
        let element =
            unsafe { ffi::mjs_findElement(self.raw, ffi::mjtObj_mjOBJ_GEOM, name.as_ptr()) };
        if element.is_null() {
            return None;
        }
        Some(SpecGeom {
            raw: unsafe { ffi::mjs_asGeom(element) },
            spec: PhantomData,
        })
    }

    /// Adds a free box body below `parent`: the body, its free joint and its
    /// box geometry, each by name.
    pub fn add_free_box(
        &mut self,
        parent: &CStr,
        names: [&CStr; 3],
        position: [f64; 3],
        half_size: [f64; 3],
        mass: f64,
    ) -> Result<()> {
        let parent = self.body(parent).context("Spec has no parent body")?;
        let [body_name, joint_name, geom_name] = names;
        unsafe {
            let body = ffi::mjs_addBody(parent, ptr::null());
            ffi::mjs_setName((*body).element, body_name.as_ptr());
            (*body).pos = position;
            let joint = ffi::mjs_addFreeJoint(body);
            ffi::mjs_setName((*joint).element, joint_name.as_ptr());
            let geom = ffi::mjs_addGeom(body, ptr::null());
            ffi::mjs_setName((*geom).element, geom_name.as_ptr());
            (*geom).type_ = ffi::mjtGeom_mjGEOM_BOX;
            (*geom).size = half_size;
            (*geom).mass = mass;
        }
        Ok(())
    }

    pub fn compile(self) -> Result<Model> {
        let raw = unsafe { ffi::mj_compile(self.raw, ptr::null()) };
        if raw.is_null() {
            let message = unsafe { CStr::from_ptr(ffi::mjs_getError(self.raw)) }
                .to_string_lossy()
                .into_owned();
            bail!("Cannot compile MuJoCo model: {message}");
        }
        Ok(Model::adopt(raw))
    }
}
