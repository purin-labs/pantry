use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=MUJOCO_DIR");
    println!("cargo:rerun-if-env-changed=MUJOCO_STATIC_DIR");
    let sdk = PathBuf::from(
        env::var("MUJOCO_DIR")
            .expect("Set MUJOCO_DIR to the pinned MuJoCo 4.0.0 SDK (include/ and shared library)."),
    );
    let include = sdk.join("include");
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut builder = bindgen::Builder::default()
        .header(include.join("mujoco/mujoco.h").to_str().unwrap())
        .clang_arg(format!("-I{}", include.display()))
        .allowlist_function(
            "mj_.*|mjs_findBody|mjs_findElement|mjs_asGeom|mjs_getError|mjs_addBody|mjs_addGeom|mjs_addFreeJoint|mjs_setName|mju_mat2Quat|mju_quat2Vel",
        )
        .allowlist_type("mj.*")
        .allowlist_var("mj.*")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .layout_tests(false);
    let emsdk = if target_os == "emscripten" {
        println!("cargo:rerun-if-env-changed=EMSDK");
        let emsdk = PathBuf::from(env::var("EMSDK").expect("Activate the pinned Emscripten SDK"));
        builder = builder
            .clang_arg("--target=wasm32-unknown-emscripten")
            .clang_arg(format!(
                "--sysroot={}",
                emsdk.join("upstream/emscripten/cache/sysroot").display()
            ));
        Some(emsdk)
    } else {
        None
    };
    let bindings = builder
        .generate()
        .expect("Generate bindings for pinned MuJoCo headers");
    bindings.write_to_file(out.join("mujoco.rs")).unwrap();
    let runtime_bytes = if target_os == "emscripten" {
        let static_dir = PathBuf::from(
            env::var("MUJOCO_STATIC_DIR")
                .expect("Set MUJOCO_STATIC_DIR to pinned Emscripten archives"),
        );
        println!("cargo:rustc-link-search=native={}", static_dir.display());
        let mujoco_archive = static_dir.join("libmujoco.a");
        let llvm_ar = emsdk.unwrap().join("upstream/bin/llvm-ar");
        for decoder in ["obj_decoder.cc.o", "stl_decoder.cc.o"] {
            let object = Command::new(&llvm_ar)
                .arg("p")
                .arg(&mujoco_archive)
                .arg(decoder)
                .output()
                .expect("Extract MuJoCo decoder object");
            assert!(
                object.status.success(),
                "MuJoCo decoder object missing: {decoder}"
            );
            let path = out.join(decoder);
            fs::write(&path, object.stdout).unwrap();
            println!("cargo:rustc-link-arg={}", path.display());
        }
        let mut bytes = Vec::new();
        for name in [
            "mujoco",
            "ccd",
            "qhullstatic_r",
            "tinyxml2",
            "tinyobjloader",
            "miniz",
        ] {
            let archive = static_dir.join(format!("lib{name}.a"));
            println!("cargo:rerun-if-changed={}", archive.display());
            bytes.extend(fs::read(&archive).expect("Read pinned MuJoCo archive"));
            println!("cargo:rustc-link-lib=static={name}");
        }
        println!("cargo:rustc-link-arg=-fwasm-exceptions");
        bytes
    } else {
        let library = match target_os.as_str() {
            "macos" => sdk.join("libmujoco.4.0.0.dylib"),
            "linux" => sdk.join("libmujoco.so.4.0.0"),
            other => panic!("Unsupported native platform: {other}"),
        };
        let link_name = if target_os == "macos" {
            "libmujoco.dylib"
        } else {
            "libmujoco.so"
        };
        let link = out.join(link_name);
        if link.symlink_metadata().is_ok() {
            fs::remove_file(&link).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&library, &link).unwrap();
        if target_os == "macos" {
            // The pinned macOS library uses a framework install name, including in the wheel.
            let framework = out.join("mujoco.framework/Versions/A");
            fs::create_dir_all(&framework).unwrap();
            let target = framework.join("libmujoco.4.0.0.dylib");
            if target.symlink_metadata().is_ok() {
                fs::remove_file(&target).unwrap();
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(&library, target).unwrap();
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out.display());
        }
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=dylib=mujoco");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", sdk.display());
        let package_rpath = if target_os == "macos" {
            "@executable_path/../lib"
        } else {
            "$ORIGIN/../lib"
        };
        println!("cargo:rustc-link-arg=-Wl,-rpath,{package_rpath}");
        println!("cargo:rerun-if-changed={}", library.display());
        fs::read(&library).expect("Read the pinned MuJoCo shared library")
    };
    let controller_files = [
        "src/lib.rs",
        "src/appliances.rs",
        "src/appliance_motors.rs",
        "src/appliance_thermal.rs",
        "src/appliance_espresso.rs",
        "src/appliance_pastry.rs",
        "src/appliance_services.rs",
        "src/appliance_run.rs",
        "src/mj.rs",
        "src/native/mod.rs",
        "src/native/transfer.rs",
        "src/native/appliance.rs",
        "src/native/station.rs",
        "src/ik.rs",
        "src/servo.rs",
        "src/station_reply.rs",
        "src/checkpoint.rs",
        "src/perception.rs",
        "src/closed_loop.rs",
        "src/door.rs",
        "src/robot.rs",
        "src/transfer.rs",
        "src/program.rs",
        "src/cell.rs",
        "src/host.rs",
        "src/espresso_cell.rs",
        "src/pour_over_cell.rs",
        "src/pour_over_control.rs",
        "src/pour_over_water.rs",
        "src/artifact.rs",
        "src/assets.rs",
        "src/recording.rs",
        "src/handoff.rs",
        "src/rack.rs",
        "src/limits.rs",
        "../../assets/bakery-robots/fairino-fr10/joints.json",
        "../../assets/bakery-robots/fairino-fr5/joints.json",
        "../../assets/bakery-robots/ufactory-xarm6/joints.json",
        "../../assets/bakery-robots/fanuc-crx10ial/joints.json",
        "../../assets/bakery-robots/universal-robots-ur5e/joints.json",
        "../../assets/bakery-robots/dobot-cr10/joints.json",
    ];
    let mut source_hash = Sha256::new();
    let mut hash = Sha256::new();
    for file in controller_files {
        println!("cargo:rerun-if-changed={file}");
        let bytes = fs::read(file).unwrap();
        source_hash.update(&bytes);
        hash.update(&bytes);
    }
    println!(
        "cargo:rustc-env=BAKERY_CONTROLLER_SOURCE_HASH={:x}",
        source_hash.finalize()
    );
    for file in [
        "src/main.rs",
        "src/browser.rs",
        "Cargo.lock",
        "Cargo.toml",
        "build.rs",
    ] {
        println!("cargo:rerun-if-changed={file}");
        hash.update(fs::read(file).unwrap());
    }
    let version = Command::new(env::var("RUSTC").unwrap())
        .arg("--version")
        .output()
        .unwrap();
    hash.update(version.stdout);
    hash.update(env::var("TARGET").unwrap());
    hash.update(env::var("PROFILE").unwrap());
    let rustflags = env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    for flag in rustflags.split('\x1f') {
        // A path remap names a local folder on its left side. The identity
        // keeps only the name that the build writes, so that it does not
        // depend on the machine (scripts/bakery-robots/build-paths.mjs).
        let flag = match flag
            .strip_prefix("--remap-path-prefix=")
            .and_then(|map| map.rsplit_once('='))
        {
            Some((_, to)) => format!("--remap-path-prefix={to}"),
            None => flag.to_owned(),
        };
        hash.update(flag);
        hash.update([0]);
    }
    hash.update(&runtime_bytes);
    println!(
        "cargo:rustc-env=BAKERY_RUNTIME_HASH={:x}",
        Sha256::digest(&runtime_bytes)
    );
    let assets = "../../assets/bakery-mujoco/fr10-workcell/native/assets.json";
    println!("cargo:rerun-if-changed={assets}");
    let asset_bytes = fs::read(assets).unwrap();
    hash.update(&asset_bytes);
    println!(
        "cargo:rustc-env=BAKERY_ASSETS_HASH={:x}",
        Sha256::digest(asset_bytes)
    );
    println!("cargo:rustc-env=BAKERY_RUNNER_HASH={:x}", hash.finalize());
}
