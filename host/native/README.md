# obsid-native

Native host for the obsid 3D renderer. Loads an obsid-built `.wasm` via
wasmtime, opens a winit window, and drives a wgpu render pipeline — the
same Almide program the browser host runs, unchanged.

Design doc: [`../../docs/native-host.md`](../../docs/native-host.md).

## Build

```bash
cd host/native
cargo build --release
```

First build pulls wasmtime + wgpu + winit; expect a minute or two.

## Run

Point it at a wasm built from any obsid example:

```bash
cargo run --release -- ../browser/examples/sphere.wasm
```

Orbit camera: left-click drag to rotate, scroll to zoom.

## What works (Phase 1)

- `obsid.*` imports: mesh upload, camera, directional + point lights, fog,
  Blinn-Phong material, transparency (back-to-front sorted).
- Exports: `_start`, `render_frame`, `on_pointer_{down,up,move,leave}`,
  `on_wheel`, `on_resize`.
- WASI preview1 (stdio + clock + random).

## Not yet

- Textures (stubbed — `upload_texture` is a no-op).
- Keyboard events (`on_key_down` / `on_key_up`).
- Quality presets (MSAA, mipmaps, anisotropic filtering).
- `obsid.webgl` / `obsid.canvas` hosts.

See [`../../docs/native-host.md`](../../docs/native-host.md) §8 for the open
design questions.
