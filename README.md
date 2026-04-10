# almide/obsid

**3D rendering foundation for [Almide](https://github.com/almide/almide)** — WASM builds vertex buffers directly in linear memory, JS reads them zero-copy and draws with WebGL.

### 🌐 Live demo: **[almide.github.io/obsid](https://almide.github.io/obsid/)**

Switch between examples in the top-left picker:

| | |
|---|---|
| **Heightmap** | Procedural terrain with analytic gradient normals |
| **Triangle** | Minimal example — 3 vertices, per-vertex colors |
| **Sphere** | UV sphere, 64×32 segments, parametric generation |
| **Torus** | Surface of revolution, 96×32 segments |

---

## What this is

obsid is a thin WebGL renderer driven entirely by WASM. Your Almide code:

1. Allocates a `Bytes` buffer in WASM linear memory
2. Writes vertex data with `bytes.set_f32_le` (native `f32.store` WASM instruction)
3. Writes indices with `bytes.set_u16_le`
4. Calls `obsid.upload_mesh(id, ptr, count, ...)` with `bytes.data_ptr()`

obsid then creates a typed-array view over the same memory (`new Float32Array(memory.buffer, ptr, len)`) — **zero copy** — and uploads to WebGL. No per-vertex FFI overhead, no JS scene graph.

```
Almide WASM                          obsid.js
┌─────────────────────────┐          ┌──────────────────────┐
│ bytes.new(size)          │          │                      │
│ bytes.set_f32_le(pos...) ├──ptr────→│ new Float32Array(    │
│ bytes.set_u16_le(idx...) │          │   memory.buffer,     │
│ bytes.data_ptr(buf)      │          │   ptr, count)        │
│                          │          │ gl.bufferData(...)   │
│ camera/lights/fog        │──FFI────→│ WebGL rendering      │
│ render()                 │          │                      │
└─────────────────────────┘          └──────────────────────┘
```

**What obsid knows**: vertex/index buffers, shaders, camera, lights, fog, draw calls.

**What obsid does NOT know**: chunks, blocks, scene graphs, particles. Those belong to the application layer.

## Requires

- **Almide ≥ 0.13.2** for `bytes.set_f32_le`, `bytes.data_ptr`, and the DCE fix that preserves extern fn calls
- A browser with WebGL 1 support (any modern browser)

## Quick Start

```almide
import obsid

effect fn main() -> Unit = {
  let verts = bytes.new(3 * 36)
  let idx = bytes.new(3 * 2)

  // v0 — top, red. pos(3) + norm(3) + color(3) = 36 bytes per vertex
  bytes.set_f32_le(verts, 0,  0.0)
  bytes.set_f32_le(verts, 4,  1.0)
  bytes.set_f32_le(verts, 8,  0.0)
  bytes.set_f32_le(verts, 12, 0.0); bytes.set_f32_le(verts, 16, 0.0); bytes.set_f32_le(verts, 20, 1.0)
  bytes.set_f32_le(verts, 24, 1.0); bytes.set_f32_le(verts, 28, 0.2); bytes.set_f32_le(verts, 32, 0.2)

  // v1, v2 similarly...

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

Build and serve locally:

```bash
almide build src/main.almd --target wasm -o host/examples/heightmap.wasm
cd host && python3 -m http.server 8765
# open http://localhost:8765
```

See [`examples/`](examples/) for more:

- [`triangle.almd`](examples/triangle.almd) — hello world
- [`sphere.almd`](examples/sphere.almd) — procedural UV sphere
- [`torus.almd`](examples/torus.almd) — procedural torus
- [`src/main.almd`](src/main.almd) — heightmap terrain

## Vertex format

36 bytes per vertex, little-endian:

```
offset  type  field
  0     f32   pos.x
  4     f32   pos.y
  8     f32   pos.z
 12     f32   norm.x
 16     f32   norm.y
 20     f32   norm.z
 24     f32   color.r
 28     f32   color.g
 32     f32   color.b
```

Indices are `u16` LE.

## API

### Mesh

```almide
obsid.create_mesh(id: Int)
obsid.upload_mesh(id: Int, vert_ptr: Int, vert_count: Int, idx_ptr: Int, idx_count: Int)
obsid.set_mesh_position(id: Int, x: Float, y: Float, z: Float)
obsid.set_mesh_visible(id: Int, visible: Int)
obsid.delete_mesh(id: Int)
```

### Camera

```almide
obsid.set_camera(fov, aspect, near, far, px, py, pz, tx, ty, tz)
obsid.get_aspect() -> Float
```

### Lighting

```almide
obsid.set_dir_light(r, g, b, dx, dy, dz)
obsid.set_ambient(r, g, b)
obsid.set_fog(r, g, b, near, far)
```

### Rendering

```almide
obsid.render()
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

```almide
obsid.set_state(slot: Int, value: Int)
obsid.get_state(slot: Int) -> Int
obsid.set_state_f(slot: Int, value: Float)
obsid.get_state_f(slot: Int) -> Float
```

## Rendering pipeline

1. **WASM `main()`**: allocate `bytes` buffers, write vertex/index data, call `upload_mesh()`
2. **JS `upload_mesh`**: typed-array view over `memory.buffer` (zero copy) → `gl.bufferData()`
3. **WASM `render_frame(time)`**: update camera/lights/fog, call `render()`
4. **JS render**: iterate meshes, set uniforms, `drawElements()`

Per-mesh cost: 1 uniform upload + 2 buffer binds + 1 draw call. No model matrix multiply.

## On top of obsid

obsid is intentionally agnostic. Examples of what you can build on top:

- **Voxel engine** — chunks, greedy meshing, block placement
- **Scene graph** — hierarchical transforms, material system
- **Procedural geometry** — heightmaps, lathe, marching cubes
- **Particle systems** — per-frame mesh rebuilds
- **Debug visualization** — wireframes, gizmos, normals

All of these construct vertex buffers in WASM and hand pointers to obsid.
