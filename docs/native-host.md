# obsid — Native Host Design

**Status:** draft
**Last updated:** 2026-04-17
**Scope:** native (non-browser) host implementation for the `obsid` 3D renderer.
**Parent decision:** `strategy.md` §2C — committed to **C2** (abstract host interface).

This document specifies how `obsid` WASM binaries run outside the browser, starting
with a macOS proof-of-concept. The `@extern(wasm, "obsid", …)` contract is treated
as the authoritative host interface; native and browser hosts are independent
implementations of the same imports.

---

## 1. Goals and non-goals

**Goals**

- A single native binary renders `examples/sphere.almd` on macOS with orbit camera,
  lighting, and fog — the same `.wasm` the browser host loads, unchanged.
- Host implementation is cross-platform (macOS / Windows / Linux) by construction.
  The macOS demo is the validation target, not a platform-specific fork.
- Contract parity: everything the browser host implements for `obsid.*` imports
  is implemented natively. Any divergence is a bug, not a feature.

**Non-goals (for Phase 1)**

- Mobile (iOS / Android). Same stack can reach them later; not in scope now.
- `obsid.webgl` / `obsid.canvas` native hosts. Separate follow-ups.
- Hot-reload, asset pipeline, editor integration.
- Performance tuning past "smooth on an M-series Mac at native resolution."

---

## 2. Runtime stack

| Layer | Choice | Why |
|---|---|---|
| WASM runtime | **wasmtime** | Stable, BSD-licensed, Bytecode Alliance, WASI preview1 built-in. |
| GPU abstraction | **wgpu** | Single API over Metal / Vulkan / D3D12 / GL. macOS picks Metal automatically. |
| Window + input | **winit** | De facto cross-platform window/event crate in the Rust ecosystem. |
| Shader language | **WGSL** (ported from the browser host's GLSL ES 1.00) | Native to wgpu; naga emits backend-appropriate code. |
| Host language | **Rust** | Only language with first-class bindings for all three of the above. |

All four are actively maintained, widely used, and compose cleanly. No custom
runtime work needed; the native host is mostly glue.

---

## 3. Host contract surface

The `obsid.*` namespace has ~30 imports (see `src/mod.almd`). They fall into
five groups; the native host must implement all of them.

| Group | Imports | Native implementation |
|---|---|---|
| State | `set_state`, `get_state`, `set_state_f`, `get_state_f` | Two `HashMap<i32, …>` (i64 and f32). |
| Mesh | `create_mesh`, `upload_mesh`, `set_mesh_position/rotation/scale/material/alpha/visible`, `delete_mesh` | `HashMap<i32, Mesh>`; upload goes to wgpu vertex + index buffers. |
| Texture | `upload_texture`, `set_mesh_texture`, `clear_mesh_texture`, `delete_texture` | `HashMap<i32, wgpu::Texture>` with sampled view + sampler. |
| Camera / lighting | `set_camera`, `get_aspect`, `set_dir_light`, `set_ambient`, `set_fog`, `set_point_light`, `clear_point_light` | Plain struct mirrors of the JS side. |
| Render | `render` | Record + submit a wgpu command encoder. |
| Math | `sin`, `cos`, `sqrt`, `abs`, `min`, `max`, `floor`, `pi`, `pow`, `to_float`, `to_int` | Rust `f64` / `f32` standard ops. |

WASI preview1 is supplied by `wasmtime-wasi`. The browser host stubs
filesystem calls with `ERRNO_NOSYS`; native can do the same or wire a real
preopen later — irrelevant for the graphics contract.

### Vertex format

Pos(3) + Norm(3) + Color(3) + UV(2) = 11 × `f32` = 44 bytes, interleaved.
Identical to the browser host. Native host reads directly from wasm linear
memory via `memory.data(&mut store)` — zero-copy.

---

## 4. WASM exports and event loop

Exports the host calls (optional unless marked required):

- `memory` (required)
- `_start` (required — called once after instantiation)
- `render_frame(time_secs: f32)` (required — called each frame)
- `on_pointer_down(x, y, button)` / `on_pointer_move(x, y)` / `on_pointer_up(x, y, button)` / `on_pointer_leave()`
- `on_wheel(delta_y)`
- `on_key_down(keycode, shift, ctrl, alt)` / `on_key_up(…)`
- `on_resize(w, h)`
- `on_blur()` / `on_focus()` / `on_visibility_change(visible)`

Missing handlers are silently dropped (same as browser host).

### winit → exports mapping

| winit event | Export |
|---|---|
| `MouseInput { state: Pressed, … }` | `on_pointer_down` |
| `CursorMoved` | `on_pointer_move` |
| `MouseInput { state: Released, … }` | `on_pointer_up` |
| `CursorLeft` | `on_pointer_leave` |
| `MouseWheel` | `on_wheel` |
| `KeyboardInput { state: Pressed, … }` | `on_key_down` |
| `KeyboardInput { state: Released, … }` | `on_key_up` |
| `Resized` | `on_resize` (also triggers wgpu surface reconfigure) |
| `Focused(false)` | `on_blur` |
| `Focused(true)` | `on_focus` |
| `Occluded(b)` | `on_visibility_change(!b)` |

Key codes: the browser host forwards JavaScript `keyCode`. Native host must
translate winit's `KeyCode` to the same numeric space, or (better) we freeze
a neutral obsid keycode table in Phase 1 and migrate both hosts to it.
**Open:** which path — see §8.

---

## 5. Shader port (GLSL ES 1.00 → WGSL)

The browser host carries one vertex + one fragment shader (Blinn-Phong with
directional + up to 2 point lights, fog, optional texture, sRGB↔linear gamma).
Porting to WGSL is a once-and-done job:

- Uniforms consolidated into a single `Uniforms` uniform buffer (wgpu's
  natural layout). The browser uses individual `uniform*` calls; that's a
  WebGL 1 restriction, not a design choice worth preserving.
- `MAX_POINTS = 2` preserved (matches the browser host's mobile-safe cap).
- `sRGB ↔ linear` math is identical; WGSL has `pow` natively.
- Quality presets (`low` … `max`): MSAA and texture filtering map to wgpu
  sample counts and `SamplerDescriptor`. Mipmap generation requires a compute
  or blit pass — defer to Phase 2 if it blocks Phase 1.

---

## 6. Repository layout

```
obsid/
  host/
    browser/            (was: host/; moved for symmetry)
      obsid.js
      obsid-gl.js
      canvas.js
      webgl.js
      *.html
    native/             (new)
      Cargo.toml        lib + bin; re-exported via the `obsid_native` crate
      src/
        lib.rs          re-exports (Gpu, RenderState, run, HostData, …)
        main.rs         thin bin — argument parsing, delegates to `run_renderer_only`
        run.rs          winit App + wasmtime instantiate + event loop (generic over HostData)
        runtime.rs      RenderState + `register_obsid_imports<T>(linker, accessor)`
        gpu.rs          wgpu device / pipeline / Uniforms / matrix helpers
        shaders.wgsl
```

The `browser/` rename is a fait accompli once native lands; doing it in the
same change keeps `host/` honest as the "all hosts" directory.

---

## 7. Phase 1 scope — macOS sphere demo

**Acceptance:** `cd host/native && cargo run -- ../browser/examples/sphere.wasm`
opens a window on macOS and renders the sphere with working orbit camera.

Checklist:

- [x] `host/native/` Rust crate scaffolded (wasmtime + wgpu + winit + pollster).
- [x] wasmtime instance with `obsid.*` imports wired (state + math first — cheap wins).
- [x] winit window + wgpu surface (Metal backend on macOS).
- [x] WGSL port of the browser shader.
- [x] Mesh upload path: read wasm memory → wgpu buffers.
- [x] `render` import records and submits a frame.
- [x] Event forwarders: pointer + wheel (enough for orbit camera).
- [x] `browser/` directory rename + README update.
- [x] Library split (lib + bin) so downstream hosts (aituber-poc) can embed the renderer without duplicating winit / wasmtime plumbing.

**Out of scope for Phase 1:** textures, point lights, transparency sort,
keyboard, quality presets beyond one, window resize. Each lands as a small
follow-up once the skeleton is proven.

---

## 8. Open questions

| # | Question | Tentative |
|---|---|---|
| N1 | Keep browser's JS-keyCode space, or define a neutral obsid keycode table? | Neutral table — it's the right call under C2, and the browser host's map is ~30 lines to update. |
| N2 | Ship native host in this repo (`host/native/`) or as `almide/obsid-native`? | Same repo — the contract and the host move together; splitting just adds sync cost while both are churning. |
| N3 | When we add `obsid.webgl` native, emulate WebGL 1 on wgpu, or introduce a `wasm-wgpu` modern binding? | Defer — Phase 1 is `obsid` only. Revisit when Phase 2 starts. |
| N4 | Mipmap generation for the `high` / `max` quality presets | Defer to Phase 2. Phase 1 ships with one preset. |
| N5 | Audio, filesystem, network — other non-graphics capabilities a native binary might want | Out of scope; `obsid` is a renderer. Separate packages if/when needed. |

N1 and N2 should be resolved before the first commit to `host/native/`.
N3–N5 can stay open.
