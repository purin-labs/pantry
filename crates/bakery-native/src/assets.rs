use crate::robot::Robot;
use crate::{
    artifact::{BakeryTask, Case, Layout, Request, digest, read_json},
    native::Engine,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
};

const DIRECTORY: &str = "assets/bakery-mujoco/fr10-workcell/native";

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Cell {
    Separate,
    Combined,
    BlockedRack,
    UnreachableRack,
    PanStaging,
    SpannerOven,
    SpannerOvenDoor,
}

impl Cell {
    fn stem(self) -> &'static str {
        match self {
            Self::Separate => "separate",
            Self::Combined => "combined",
            Self::BlockedRack => "combined-blocked-rack",
            Self::UnreachableRack => "combined-unreachable-rack",
            Self::PanStaging => "pan-staging",
            Self::SpannerOven => "spanner-oven",
            Self::SpannerOvenDoor => "spanner-oven-door",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Fixture {
    Rack,
    OvenAndRack {
        pose: [f64; 7],
        #[serde(rename = "doorAngle")]
        door_angle: f64,
        #[serde(rename = "glbSha256")]
        glb_sha256: String,
    },
    MaruzenOven {
        pose: [f64; 7],
        #[serde(rename = "doorAngle")]
        door_angle: f64,
        #[serde(rename = "glbSha256")]
        glb_sha256: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Geometry {
    pub name: String,
    pub body: String,
    pub shape: String,
    pub size: [f64; 3],
    pub pose: [f64; 7],
    pub rgba: [f64; 4],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Setup {
    pub initial_state: Vec<f64>,
    pub robot_base: [f64; 7],
    pub fixture: Fixture,
    pub geometry: Vec<Geometry>,
}

/// A model file that is not present. In the browser, the worker mounts the
/// model pack that holds it and sends the refused command again; the
/// command changed nothing (Refactor 16, step 11).
#[derive(Debug)]
pub struct Missing(pub String);

impl fmt::Display for Missing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Missing model file: {}", self.0)
    }
}

impl std::error::Error for Missing {}

/// Refuses a file that is not present, with its path below the asset root.
pub fn require(path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let path = path.to_string_lossy();
    Err(Missing(path.trim_start_matches('/').to_string()).into())
}

/// The missing model file behind an error, if a missing file caused it.
pub fn missing(error: &anyhow::Error) -> Option<&str> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<Missing>())
        .map(|missing| missing.0.as_str())
}

pub struct Assets {
    root: PathBuf,
    manifest_hash: String,
    robot_glb_sha256: BTreeMap<String, String>,
}

impl Assets {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub fn load(root: &Path) -> Result<Self> {
        let manifest = root.join(DIRECTORY).join("assets.json");
        let bytes = fs::read(&manifest)?;
        ensure!(
            digest(&bytes) == env!("BAKERY_ASSETS_HASH"),
            "Asset build differs from this runner"
        );
        let files: BTreeMap<String, String> = read_json(&manifest)?;
        // The browser worker checks the SHA-256 of each model pack once,
        // before it mounts the pack, and the bundle names each pack by its
        // digest. The module does not hash the files a second time, and it
        // holds only the packs that its jobs needed so far.
        #[cfg(not(target_os = "emscripten"))]
        for (path, expected) in &files {
            ensure!(
                digest(&fs::read(root.join(path))?) == *expected,
                "Asset changed: {path}"
            );
        }
        Ok(Self {
            root: root.to_path_buf(),
            manifest_hash: digest(&bytes),
            robot_glb_sha256: Robot::ALL
                .into_iter()
                .map(|robot| {
                    (
                        robot.slug().to_string(),
                        files[&format!("assets/bakery-robots/{}/robot.glb", robot.slug())].clone(),
                    )
                })
                .collect(),
        })
    }

    /// The pour-over station's compiled model, its setup and its identity.
    /// The station exists for the FR10 only.
    pub fn pour_over(&self) -> (PathBuf, PathBuf, String) {
        let stem = self
            .root
            .join(DIRECTORY)
            .join(Robot::FairinoFr10.slug())
            .join("pour-over-station");
        (
            stem.with_extension("xml"),
            stem.with_extension("json"),
            digest(
                format!(
                    "pour-over-v1:{}:{}",
                    Robot::FairinoFr10.slug(),
                    self.manifest_hash
                )
                .as_bytes(),
            ),
        )
    }

    pub fn robot_glb_sha256(&self, robot: Robot) -> &str {
        &self.robot_glb_sha256[robot.slug()]
    }

    pub fn model_hash(&self, robot: Robot, cell: Cell) -> String {
        digest(
            format!(
                "robot-v1:{}:{}:{}",
                robot.slug(),
                cell.stem(),
                self.manifest_hash
            )
            .as_bytes(),
        )
    }

    pub fn layout_hash(&self, robot: Robot, cell: Cell, layout: Layout) -> Result<String> {
        match layout {
            Layout::Fixed => Ok(self.model_hash(robot, cell)),
            Layout::RackTranslation { x_mm, y_mm } => {
                ensure!(
                    cell == Cell::Separate,
                    "Rack placement requires the standalone fixture"
                );
                ensure!(
                    Layout::rack(x_mm, y_mm)? == layout,
                    "Noncanonical rack placement"
                );
                Ok(digest(
                    format!(
                        "rack-layout-v1:mujoco-4.0.0:{}:{x_mm}:{y_mm}",
                        self.model_hash(robot, cell)
                    )
                    .as_bytes(),
                ))
            }
        }
    }

    fn cell(&self, request: &Request) -> Result<Cell> {
        if request.layout != Layout::Fixed {
            ensure!(
                request.model_hash
                    == self.layout_hash(request.robot, Cell::Separate, request.layout)?,
                "Request layout/model identity differs"
            );
            return Ok(Cell::Separate);
        }
        for cell in [
            Cell::Separate,
            Cell::Combined,
            Cell::BlockedRack,
            Cell::UnreachableRack,
            Cell::PanStaging,
            Cell::SpannerOven,
            Cell::SpannerOvenDoor,
        ] {
            if request.model_hash == self.model_hash(request.robot, cell) {
                return Ok(cell);
            }
        }
        anyhow::bail!("Request model hash differs from verified fixtures")
    }

    pub fn is_combined(&self, request: &Request) -> bool {
        matches!(
            self.cell(request),
            Ok(Cell::Combined | Cell::BlockedRack | Cell::UnreachableRack)
        )
    }

    pub fn validate_request(&self, request: &Request) -> Result<Cell> {
        let cell = self.cell(request)?;
        request.validate(&self.layout_hash(request.robot, cell, request.layout)?)?;
        if cell == Cell::PanStaging {
            ensure!(
                request.robot == Robot::FairinoFr10
                    && request.bakery_task_id == BakeryTask::Rack
                    && request.ingredients.mass_kg == 0.
                    && request.ingredients.forward_mm == 0
                    && request.ingredients.lateral_mm == 0,
                "Pan staging requires the FR10 empty-pan carrier fixture"
            );
        }
        if cell == Cell::SpannerOven {
            ensure!(
                request.robot == Robot::FairinoFr10
                    && matches!(
                        request.bakery_task_id,
                        BakeryTask::Oven | BakeryTask::Unload
                    )
                    && matches!(
                        request.case,
                        Case::Nominal | Case::Slip | Case::ClosedDoor | Case::Blocked
                    ),
                "Spanner oven requires the FR10 MBCO-4ME spanner-gripper fixture"
            );
        }
        if cell == Cell::SpannerOvenDoor {
            ensure!(
                request.robot == Robot::FairinoFr10
                    && matches!(
                        request.bakery_task_id,
                        BakeryTask::Oven | BakeryTask::Unload
                    )
                    && request.case == Case::Nominal,
                "Spanner oven door requires the FR10 MBCO-4ME articulated-door fixture"
            );
        }
        ensure!(
            !matches!(cell, Cell::BlockedRack | Cell::UnreachableRack)
                || matches!(request.case, Case::Nominal | Case::Slip),
            "Rack fault fixtures require nominal loading"
        );
        Ok(cell)
    }

    fn input_path(&self, request: &Request) -> Result<PathBuf> {
        let cell = self.validate_request(request)?;
        let task = match request.bakery_task_id {
            BakeryTask::Rack => "table-to-rack",
            BakeryTask::Oven | BakeryTask::Unload => "table-to-oven",
        };
        let case = match request.case {
            Case::Nominal | Case::Slip => "nominal",
            Case::Blocked => "blocked",
            Case::Unreachable => "unreachable",
            Case::ClosedDoor => "closed-door",
        };
        let task = if cell == Cell::Separate {
            task
        } else {
            cell.stem()
        };
        Ok(self
            .root
            .join(DIRECTORY)
            .join(request.robot.slug())
            .join(format!("{task}-{case}")))
    }

    pub fn setup(&self, request: &Request) -> Result<Setup> {
        let mut setup: Setup = read_json(&self.input_path(request)?.with_extension("json"))?;
        let offset = request.layout.offset();
        if request.ingredients.mass_kg == 0. {
            setup
                .geometry
                .retain(|geometry| geometry.name != "cold_contents");
        }
        for geometry in &mut setup.geometry {
            if geometry.name == "cold_contents" {
                geometry.pose[0] = -f64::from(request.ingredients.lateral_mm) / 1000.;
                geometry.pose[1] = f64::from(request.ingredients.forward_mm) / 1000.;
            }
            if geometry.body == "world" && geometry.name.starts_with("rack_") {
                geometry.pose[0] += offset[0];
                geometry.pose[1] += offset[1];
            }
        }
        Ok(setup)
    }

    /// The request's fixture compiled for a persistent cell. Its bodies start
    /// where the model places them; the cell sets its own initial state.
    pub fn open_persistent(&self, request: &Request) -> Result<Engine> {
        let path = self.input_path(request)?;
        let mut engine = Engine::load_persistent(
            &path.with_extension("xml"),
            request.layout,
            request.robot,
            request.ingredients,
        )?;
        engine.configure_clamp(request.clamp_force_n);
        engine.set_timestep(request.timestep);
        Ok(engine)
    }

    pub fn open(&self, request: &Request) -> Result<(Engine, Setup)> {
        let path = self.input_path(request)?;
        let setup = self.setup(request)?;
        let mut engine = Engine::load(
            &path.with_extension("xml"),
            request.layout,
            request.robot,
            request.ingredients,
        )?;
        engine.configure_clamp(request.clamp_force_n);
        engine.set_timestep(request.timestep);
        engine.restore(&setup.initial_state)?;
        Ok((engine, setup))
    }
}
