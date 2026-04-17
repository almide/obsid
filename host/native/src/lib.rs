//! Native host for the obsid graphics runtime, as an embeddable library.
//!
//! Other hosts (e.g. `aituber-poc`) wrap this with their own wasmtime `Store`
//! data type and compose additional import namespaces on top of `obsid.*`.

pub mod gpu;
pub mod run;
pub mod runtime;

pub use gpu::{
    mat4_compose_trs, mat4_look_at, mat4_mul, mat4_perspective, Gpu, Mesh, Uniforms, MAX_POINTS,
    VERTEX_STRIDE,
};
pub use run::{load_wasm_from_args, run, run_renderer_only, HostData};
pub use runtime::{register_obsid_imports, RenderState};

// Re-exports so callers don't need to pull wasmtime/wasmtime-wasi directly.
pub use wasmtime::{self, Linker};
pub use wasmtime_wasi::preview1::{add_to_linker_sync as add_wasi_to_linker, WasiP1Ctx};
pub use wasmtime_wasi::WasiCtxBuilder;
