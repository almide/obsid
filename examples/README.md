# obsid examples

Each example is a standalone Almide program that builds a mesh in WASM linear memory and uploads it to obsid for rendering.

## Examples

| File | Description |
|---|---|
| `triangle.almd` | Hello world — 3 vertices, per-vertex colors, orbit camera |
| `sphere.almd` | Procedural UV sphere — nested for loops, parametric normals |
| `torus.almd` | Procedural torus — surface of revolution, analytic normals |

The default demo at `src/main.almd` is a heightmap terrain with analytic gradient normals.

## Build

Each example produces its own `app.wasm`. Build one at a time and serve:

```bash
# Heightmap (default)
almide build src/main.almd --target wasm -o host/app.wasm

# Triangle
almide build examples/triangle.almd --target wasm -o host/app.wasm

# Sphere
almide build examples/sphere.almd --target wasm -o host/app.wasm

# Torus
almide build examples/torus.almd --target wasm -o host/app.wasm

# Serve
cd host && python3 -m http.server 8765
# Open http://localhost:8765
```

## Pattern

All examples follow the same structure:

1. **Allocate buffers** — `bytes.new(vertex_count * 36)` and `bytes.new(index_count * 2)`
2. **Fill vertices** — `bytes.set_f32_le` for positions, normals, colors (9 floats per vertex)
3. **Fill indices** — `bytes.set_u16_le` for triangle indices
4. **Upload** — `obsid.upload_mesh(id, bytes.data_ptr(verts), vc, bytes.data_ptr(idx), ic)`
5. **Render loop** — `render_frame(time)` updates camera/lights/fog and calls `obsid.render()`

The mesh data lives in WASM linear memory throughout its lifetime. obsid reads from it via `new Float32Array(memory.buffer, ptr, len)` — zero copy.

## Vertex format (36 bytes, LE)

```
offset  type  name
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
