//! The typed interface the browser worker calls. One command crosses as
//! JSON and its reply stays in the module's memory until the next command.
use anyhow::{Context, Result};
use bakery_native::{assets::Assets, host::Host as Cells};
use std::{cell::RefCell, path::Path};

const FAILED: i32 = -1;

#[derive(Default)]
struct Host {
    /// Persistent cells and programs, behind the protocol the native `serve` speaks.
    cells: Option<Cells>,
    response: Vec<u8>,
}

thread_local! {
    static HOST: RefCell<Host> = RefCell::default();
}

// A failure leaves its message as the response.
fn guarded(action: impl FnOnce(&mut Host) -> Result<i32>) -> i32 {
    HOST.with_borrow_mut(|host| match action(host) {
        Ok(code) => code,
        Err(error) => {
            host.response = error.to_string().into_bytes();
            FAILED
        }
    })
}

/// Reserves `length` bytes for the caller to write an input into.
#[unsafe(no_mangle)]
pub extern "C" fn bakery_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()).cast()
}

/// # Safety
/// `pointer` and `length` must come from one `bakery_alloc` call, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bakery_free(pointer: *mut u8, length: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)) });
}

/// Answers one cell-host command, given as JSON, and leaves its JSON reply
/// as the response. A refused command replies with its reason.
///
/// # Safety
/// `pointer` must address `length` initialized bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bakery_cell_command(pointer: *const u8, length: usize) -> i32 {
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    guarded(|host| {
        if host.cells.is_none() {
            host.cells = Some(Cells::new(Assets::load(Path::new("/"))?));
        }
        let cells = host.cells.as_mut().context("The cell host is loaded")?;
        host.response = cells.answer(input)?;
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn bakery_response_pointer() -> *const u8 {
    HOST.with_borrow(|host| host.response.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn bakery_response_length() -> usize {
    HOST.with_borrow(|host| host.response.len())
}
