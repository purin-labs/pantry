//! Supported articulated assets. Selection is part of each execution request.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Robot {
    FairinoFr10,
    FairinoFr5,
    UfactoryXarm6,
    FanucCrx10ial,
    UniversalRobotsUr5e,
    DobotCr10,
}

impl Robot {
    pub const ALL: [Self; 6] = [
        Self::FairinoFr10,
        Self::FairinoFr5,
        Self::UfactoryXarm6,
        Self::FanucCrx10ial,
        Self::UniversalRobotsUr5e,
        Self::DobotCr10,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Self::FairinoFr10 => "fairino-fr10",
            Self::FairinoFr5 => "fairino-fr5",
            Self::UfactoryXarm6 => "ufactory-xarm6",
            Self::FanucCrx10ial => "fanuc-crx10ial",
            Self::UniversalRobotsUr5e => "universal-robots-ur5e",
            Self::DobotCr10 => "dobot-cr10",
        }
    }

    pub fn joint(self, index: usize) -> String {
        let label = match self {
            Self::FairinoFr10 | Self::FairinoFr5 => format!("j{}", index + 1),
            Self::UfactoryXarm6 | Self::DobotCr10 => format!("joint{}", index + 1),
            Self::FanucCrx10ial => format!("J{}", index + 1),
            Self::UniversalRobotsUr5e => [
                "shoulder_pan_joint",
                "shoulder_lift_joint",
                "elbow_joint",
                "wrist_1_joint",
                "wrist_2_joint",
                "wrist_3_joint",
            ][index]
                .to_owned(),
        };
        format!("{}__{label}", self.slug())
    }

    pub fn owns_geometry(self, name: &str) -> bool {
        name.strip_prefix(self.slug())
            .is_some_and(|suffix| suffix.starts_with("__"))
    }
}
