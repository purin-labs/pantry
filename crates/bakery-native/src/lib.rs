//! The bakery physics engine. Only `mj` (MuJoCo) uses `unsafe`.
#![deny(unsafe_code)]

pub mod appliance_espresso;
pub mod appliance_motors;
pub mod appliance_pastry;
pub mod appliances;
pub mod artifact;
pub mod assets;
pub mod cell;
pub mod checkpoint;
pub mod espresso_cell;
pub mod handoff;
pub mod host;
pub mod ik;
pub mod limits;
#[allow(unsafe_code)]
pub mod mj;
pub mod native;
pub mod pour_over_cell;
pub mod pour_over_control;
pub mod pour_over_water;
pub mod program;
pub mod rack;
pub mod recording;
pub mod transfer;

pub mod appliance_run;
pub mod appliance_services;
pub mod appliance_thermal;

pub mod robot;
pub mod servo;
pub mod station_reply;
