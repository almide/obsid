//! Host kit: winit window + wgpu surface + wasmtime instance + event loop,
//! generic over the user's store data type.
//!
//! This glues obsid rendering to the surrounding plumbing every Almide
//! native app needs. It intentionally does not depend on anything
//! application-specific — once a second consumer appears alongside obsid,
//! this module is a candidate for extraction into a sibling `almide/host-kit`
//! crate.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use wasmtime::{Config, Engine, Instance, Linker, Module, Store, TypedFunc};
use wasmtime_wasi::preview1::{self as preview1, WasiP1Ctx};
use wasmtime_wasi::WasiCtxBuilder;
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

use crate::gpu::Gpu;
use crate::runtime::{register_obsid_imports, RenderState};

/// Composite store data types implement this to expose their renderer slice
/// and WASI context to [`run`]. Callers add their own fields (audio, http,
/// …) freely; those get wired via the `extra_imports` closure.
pub trait HostData: Send + 'static {
    fn render(&mut self) -> &mut RenderState;
    fn wasi(&mut self) -> &mut WasiP1Ctx;
}

/// Launch an Almide native app. Blocks on the winit event loop until the
/// window is closed.
///
/// - `make_state` builds the wasmtime store data once the GPU is ready.
/// - `extra_imports` is called after obsid's renderer imports and WASI are
///   wired so callers can add their own namespaces (audio, http, …) on the
///   same linker.
pub fn run<T, M, I>(
    wasm_bytes: Vec<u8>,
    title: impl Into<String>,
    make_state: M,
    extra_imports: I,
) -> Result<()>
where
    T: HostData,
    M: FnOnce(Gpu, WasiP1Ctx) -> T + 'static,
    I: FnOnce(&mut Linker<T>) -> Result<()> + 'static,
{
    let mut config = Config::new();
    config.async_support(false);
    // Almide codegen emits `return_call` — wasm tail-call proposal.
    config.wasm_tail_call(true);
    let engine = Engine::new(&config)?;

    let event_loop = EventLoop::new().context("create event loop")?;
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app: App<T, M, I> = App {
        wasm_bytes,
        title: title.into(),
        engine,
        make_state: Some(make_state),
        extra_imports: Some(extra_imports),
        window: None,
        runtime: None,
        start: None,
        pointer_pos: PhysicalPosition::new(0.0, 0.0),
    };
    event_loop.run_app(&mut app).context("run app")?;
    Ok(())
}

/// Convenience wrapper around [`run`] when the host has no extra imports
/// beyond obsid's renderer. The obsid-native standalone binary uses this.
pub fn run_renderer_only(wasm_bytes: Vec<u8>, title: impl Into<String>) -> Result<()> {
    struct MinimalState {
        render: RenderState,
        wasi: WasiP1Ctx,
    }
    impl HostData for MinimalState {
        fn render(&mut self) -> &mut RenderState { &mut self.render }
        fn wasi(&mut self) -> &mut WasiP1Ctx { &mut self.wasi }
    }
    run::<MinimalState, _, _>(
        wasm_bytes,
        title,
        |gpu, wasi| MinimalState {
            render: RenderState::new(gpu),
            wasi,
        },
        |_linker| Ok(()),
    )
}

/// Parse CLI args of the form `<bin> <wasm-path>` and read the wasm file.
/// Returns `(PathBuf, Vec<u8>)`.
pub fn load_wasm_from_args(bin_hint: &str) -> Result<(PathBuf, Vec<u8>)> {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("usage: {} <path-to-wasm>", bin_hint))?;
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading wasm: {}", path.display()))?;
    Ok((path, bytes))
}

// ── Internals ────────────────────────────────────────────────────────

/// Every Almide-exported handler returns `i32` (effect status code). We
/// ignore the value; the browser host does too.
struct Runtime<T: 'static> {
    store: Store<T>,
    render_frame: TypedFunc<f64, i32>,
    on_pointer_down: Option<TypedFunc<(f64, f64, i64), i32>>,
    on_pointer_up: Option<TypedFunc<(f64, f64, i64), i32>>,
    on_pointer_move: Option<TypedFunc<(f64, f64), i32>>,
    on_pointer_leave: Option<TypedFunc<(), i32>>,
    on_wheel: Option<TypedFunc<f64, i32>>,
    on_resize: Option<TypedFunc<(i64, i64), i32>>,
}

fn render_accessor<T: HostData>(s: &mut T) -> &mut RenderState {
    s.render()
}

fn instantiate<T, M, I>(
    engine: &Engine,
    wasm_bytes: &[u8],
    gpu: Gpu,
    make_state: M,
    extra_imports: I,
) -> Result<Runtime<T>>
where
    T: HostData,
    M: FnOnce(Gpu, WasiP1Ctx) -> T,
    I: FnOnce(&mut Linker<T>) -> Result<()>,
{
    let module = Module::new(engine, wasm_bytes).context("parse wasm module")?;
    let wasi = WasiCtxBuilder::new().inherit_stdio().build_p1();
    let mut store = Store::new(engine, make_state(gpu, wasi));

    let mut linker: Linker<T> = Linker::new(engine);
    preview1::add_to_linker_sync(&mut linker, |s: &mut T| s.wasi())
        .context("add wasi to linker")?;
    register_obsid_imports(&mut linker, render_accessor::<T>)
        .context("register obsid imports")?;
    extra_imports(&mut linker).context("register extra imports")?;

    let instance: Instance = linker
        .instantiate(&mut store, &module)
        .context("instantiate wasm module")?;

    let memory = instance
        .get_memory(&mut store, "memory")
        .context("wasm module has no exported `memory`")?;
    store.data_mut().render().memory = Some(memory);

    if let Some(start) = instance.get_typed_func::<(), i32>(&mut store, "_start").ok() {
        let _ = start.call(&mut store, ()).context("_start")?;
    }

    let render_frame = instance
        .get_typed_func::<f64, i32>(&mut store, "render_frame")
        .context("wasm module must export render_frame(f64)")?;
    let on_pointer_down = instance
        .get_typed_func::<(f64, f64, i64), i32>(&mut store, "on_pointer_down")
        .ok();
    let on_pointer_up = instance
        .get_typed_func::<(f64, f64, i64), i32>(&mut store, "on_pointer_up")
        .ok();
    let on_pointer_move = instance
        .get_typed_func::<(f64, f64), i32>(&mut store, "on_pointer_move")
        .ok();
    let on_pointer_leave = instance
        .get_typed_func::<(), i32>(&mut store, "on_pointer_leave")
        .ok();
    let on_wheel = instance
        .get_typed_func::<f64, i32>(&mut store, "on_wheel")
        .ok();
    let on_resize = instance
        .get_typed_func::<(i64, i64), i32>(&mut store, "on_resize")
        .ok();

    Ok(Runtime {
        store,
        render_frame,
        on_pointer_down,
        on_pointer_up,
        on_pointer_move,
        on_pointer_leave,
        on_wheel,
        on_resize,
    })
}

struct App<T, M, I>
where
    T: HostData,
    M: FnOnce(Gpu, WasiP1Ctx) -> T,
    I: FnOnce(&mut Linker<T>) -> Result<()>,
{
    wasm_bytes: Vec<u8>,
    title: String,
    engine: Engine,
    make_state: Option<M>,
    extra_imports: Option<I>,
    window: Option<Arc<Window>>,
    runtime: Option<Runtime<T>>,
    start: Option<Instant>,
    pointer_pos: PhysicalPosition<f64>,
}

fn mouse_button_code(b: MouseButton) -> i64 {
    match b {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(code) => code as i64,
    }
}

impl<T, M, I> ApplicationHandler for App<T, M, I>
where
    T: HostData,
    M: FnOnce(Gpu, WasiP1Ctx) -> T,
    I: FnOnce(&mut Linker<T>) -> Result<()>,
{
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title(self.title.clone())
                        .with_inner_size(winit::dpi::LogicalSize::new(900, 600)),
                )
                .expect("create window"),
        );
        let gpu = pollster::block_on(Gpu::new(window.clone())).expect("init gpu");
        let make_state = self.make_state.take().expect("make_state already consumed");
        let extra_imports = self
            .extra_imports
            .take()
            .expect("extra_imports already consumed");
        let runtime = instantiate(
            &self.engine,
            &self.wasm_bytes,
            gpu,
            make_state,
            extra_imports,
        )
        .expect("instantiate wasm");
        self.window = Some(window);
        self.runtime = Some(runtime);
        self.start = Some(Instant::now());
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let (Some(window), Some(runtime)) = (self.window.as_ref(), self.runtime.as_mut()) else {
            return;
        };

        match event {
            WindowEvent::CloseRequested => event_loop.exit(),

            WindowEvent::Resized(size) => {
                let w = size.width.max(1);
                let h = size.height.max(1);
                runtime.store.data_mut().render().gpu.resize(w, h);
                if let Some(f) = runtime.on_resize.as_ref() {
                    let _ = f.call(&mut runtime.store, (w as i64, h as i64));
                }
                window.request_redraw();
            }

            WindowEvent::CursorMoved { position, .. } => {
                self.pointer_pos = position;
                if let Some(f) = runtime.on_pointer_move.as_ref() {
                    let _ = f.call(&mut runtime.store, (position.x, position.y));
                }
            }

            WindowEvent::MouseInput { state, button, .. } => {
                let code = mouse_button_code(button);
                let (x, y) = (self.pointer_pos.x, self.pointer_pos.y);
                match state {
                    ElementState::Pressed => {
                        if let Some(f) = runtime.on_pointer_down.as_ref() {
                            let _ = f.call(&mut runtime.store, (x, y, code));
                        }
                    }
                    ElementState::Released => {
                        if let Some(f) = runtime.on_pointer_up.as_ref() {
                            let _ = f.call(&mut runtime.store, (x, y, code));
                        }
                    }
                }
            }

            WindowEvent::CursorLeft { .. } => {
                if let Some(f) = runtime.on_pointer_leave.as_ref() {
                    let _ = f.call(&mut runtime.store, ());
                }
            }

            WindowEvent::MouseWheel { delta, .. } => {
                let dy: f64 = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -(y as f64) * 40.0,
                    MouseScrollDelta::PixelDelta(p) => -p.y,
                };
                if let Some(f) = runtime.on_wheel.as_ref() {
                    let _ = f.call(&mut runtime.store, dy);
                }
            }

            WindowEvent::RedrawRequested => {
                let start = self.start.unwrap();
                let t = start.elapsed().as_secs_f64();

                let frame = match runtime
                    .store
                    .data_mut()
                    .render()
                    .gpu
                    .surface
                    .get_current_texture()
                {
                    Ok(f) => f,
                    Err(wgpu::SurfaceError::Lost) | Err(wgpu::SurfaceError::Outdated) => {
                        let rs = runtime.store.data_mut().render();
                        let (w, h) = (rs.gpu.surface_config.width, rs.gpu.surface_config.height);
                        rs.gpu.resize(w, h);
                        window.request_redraw();
                        return;
                    }
                    Err(e) => {
                        eprintln!("surface error: {e:?}");
                        return;
                    }
                };
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                runtime.store.data_mut().render().current_view = Some(view);

                if let Err(e) = runtime.render_frame.call(&mut runtime.store, t) {
                    eprintln!("render_frame: {e}");
                }

                runtime.store.data_mut().render().current_view = None;
                frame.present();
                window.request_redraw();
            }

            _ => {}
        }
    }
}
