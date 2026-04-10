# almide/obsid

Generic mesh rendering foundation for [Almide](https://github.com/almide/almide) — WASM-side vertex buffer construction with zero-copy WebGL upload.

**Requires Almide ≥ 0.13.2** (for `bytes.set_f32_le`, `bytes.data_ptr`, and DCE fix for extern fn calls).

## Architecture

```
Almide WASM                           obsid.js (JS host)
┌────────────────────────┐             ┌──────────────────────┐
│ bytes.new(size)         │             │ new Float32Array(    │
│ bytes.set_f32_le(...)  ─┼──ptr,len──→ │   memory.buffer,     │
│ bytes.set_u16_le(...)  ─┤             │   ptr, count)        │
│ bytes.data_ptr(buf)     │             │ gl.bufferData(...)   │
│                         │             │                      │
│ camera/lights/fog       │──FFI───────→│ WebGL rendering      │
│ render()                │             │  └ Lambert + fog     │
└────────────────────────┘             └──────────────────────┘
```

**What obsid knows**: vertex/index buffers, shaders, camera, lights, fog, draw calls.

**What obsid does NOT know**: chunks, blocks, scene graphs, particles. Those belong to the application layer.

Key design: the application constructs binary vertex data in WASM linear memory using Almide's `bytes` primitives, then passes a pointer to obsid. JS reads via a typed-array view over `memory.buffer` — **zero-copy**. The only per-frame FFI calls are for camera, lights, fog, and the render trigger itself.

**Vertex format (36 bytes):**
```
[pos.x, pos.y, pos.z, norm.x, norm.y, norm.z, col.r, col.g, col.b]  // 9 f32 LE
```

**Index format:** `u16 LE`

## Quick Start

```almide
import obsid

effect fn main() -> Unit = {
  // Build a tiny triangle mesh in WASM linear memory
  let verts = bytes.new(3 * 36)  // 3 vertices × 36 bytes
  let idx = bytes.new(3 * 2)      // 3 indices × 2 bytes

  // Vertex 0: pos + norm + color
  bytes.set_f32_le(verts, 0,  0.0); bytes.set_f32_le(verts, 4,  1.0); bytes.set_f32_le(verts, 8, 0.0)
  bytes.set_f32_le(verts, 12, 0.0); bytes.set_f32_le(verts, 16, 0.0); bytes.set_f32_le(verts, 20, 1.0)
  bytes.set_f32_le(verts, 24, 1.0); bytes.set_f32_le(verts, 28, 0.2); bytes.set_f32_le(verts, 32, 0.2)

  // ... vertex 1, 2 similarly ...

  bytes.set_u16_le(idx, 0, 0)
  bytes.set_u16_le(idx, 2, 1)
  bytes.set_u16_le(idx, 4, 2)

  obsid.create_mesh(0)
  obsid.upload_mesh(0, bytes.data_ptr(verts), 3, bytes.data_ptr(idx), 3)
}

pub fn render_frame(time: Float) -> Unit = {
  obsid.set_camera(60.0, obsid.get_aspect(), 0.1, 100.0,
    obsid.sin(time * 0.3) * 5.0, 3.0, obsid.cos(time * 0.3) * 5.0,
    0.0, 0.0, 0.0)
  obsid.set_dir_light(1.0, 0.95, 0.9, 0.5, 1.0, 0.3)
  obsid.set_ambient(0.2, 0.2, 0.25)
  obsid.set_fog(0.55, 0.65, 0.85, 20.0, 60.0)
  obsid.render()
}
```

Build and serve:

```bash
almide build src/main.almd --target wasm -o host/app.wasm
cd host && python3 -m http.server 8765
```

Open http://localhost:8765

See `src/main.almd` for a complete heightmap terrain example with analytic gradient-based normals.

## API

### Mesh

```almide
obsid.create_mesh(id: Int)
obsid.upload_mesh(id: Int, vert_ptr: Int, vert_count: Int, idx_ptr: Int, idx_count: Int)
obsid.set_mesh_position(id: Int, x: Float, y: Float, z: Float)
obsid.set_mesh_visible(id: Int, visible: Int)
obsid.delete_mesh(id: Int)
```

`vert_ptr` and `idx_ptr` are pointers into WASM linear memory obtained from `bytes.data_ptr()`. `vert_count` is the number of vertices (not bytes). `idx_count` is the number of indices.

### Camera

```almide
obsid.set_camera(fov, aspect, near, far, px, py, pz, tx, ty, tz)
obsid.get_aspect() -> Float                     // canvas width/height
```

### Lighting

```almide
obsid.set_dir_light(r, g, b, dx, dy, dz)       // directional sun
obsid.set_ambient(r, g, b)                      // ambient fill
obsid.set_fog(r, g, b, near, far)               // linear distance fog
```

### Rendering

```almide
obsid.render()                                  // draw all visible meshes
```

### Math

```almide
obsid.sin(x)  obsid.cos(x)  obsid.sqrt(x)  obsid.abs(x)
obsid.min(a, b)  obsid.max(a, b)  obsid.floor(x)
obsid.pow(x, y)  obsid.pi()
obsid.to_float(i: Int) -> Float
obsid.to_int(f: Float) -> Int
```

### State

Persist values across `main` and `render_frame`:

```almide
obsid.set_state(slot: Int, value: Int)
obsid.get_state(slot: Int) -> Int
obsid.set_state_f(slot: Int, value: Float)
obsid.get_state_f(slot: Int) -> Float
```

## Rendering Pipeline

1. **WASM `main()`**: allocate `bytes` buffers, write vertex/index data with `set_f32_le` / `set_u16_le`, call `upload_mesh()` with `data_ptr()` pointers.
2. **JS `upload_mesh`**: create typed-array views over `memory.buffer` at the given offsets (zero copy), call `gl.bufferData()` to GPU.
3. **WASM `render_frame(time)`**: update camera/lights/fog each frame, call `render()`.
4. **JS `render`**: iterate meshes, set uniforms, `drawElements()`.

Per-mesh cost: 1 uniform upload (`u_offset`) + 2 buffer binds + 1 draw call.

## On Top of obsid

obsid is intentionally agnostic about what kind of mesh you draw. Examples of what you can build on top:

- **Voxel engine** — chunk management, greedy meshing, block placement
- **Scene graph** — hierarchical transforms, material system
- **Procedural geometry** — sphere, torus, lathe, heightmap
- **Particle systems** — per-frame mesh rebuilds
- **Debug visualization** — wireframes, gizmos, normals

All of these construct vertex buffers in WASM and hand pointers to obsid.

## Notes on Almide

- Build with explicit source path: `almide build src/main.almd --target wasm` (not project mode, which has known issues in 0.13.2)
- All `@extern(wasm, ...)` functions should return `Unit` — the DCE fix in 0.13.2 preserves side-effectful extern calls even inside `for` loops
- `bytes.set_f32_le` / `set_u16_le` / `data_ptr` were added in 0.13.2 and compile to inline WASM (`f32.store`, `i32.store16`, etc.) with no runtime call overhead
