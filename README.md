# almide/obsid

Voxel chunk renderer for [Almide](https://github.com/almide/almide) — WASM-native terrain generation with JS/WebGL rendering.

## Architecture

```
Almide (WASM, ~4 KB)              obsid.js (JS host)
┌──────────────────────┐           ┌─────────────────────────┐
│ Terrain generation   │           │ Chunk meshing           │
│  └ for loops over    │──FFI────→ │  └ face culling         │
│    blocks per chunk  │           │  └ vertex/index buffers │
│ Per-frame updates    │           │ WebGL rendering         │
│  └ camera orbit      │──FFI────→ │  └ Lambert shading      │
│  └ lighting/fog      │           │  └ per-face AO          │
│  └ render()          │           │  └ fog                  │
└──────────────────────┘           └─────────────────────────┘
```

**WASM side** owns world logic: which blocks exist, where the camera is, how it moves. All terrain generation runs in WASM via nested `for` loops calling `set_block()`.

**JS side** owns rendering: receives block data via FFI, generates meshes (face culling, vertex buffers), and draws with WebGL. No scene graph — flat chunk iteration.

Key design: WASM never touches rendering. JS never touches game logic. The boundary is a small set of FFI calls (`create_chunk`, `set_block`, `build_chunk`, `set_camera`, `render`).

## Quick Start

```almide
import obsid

effect fn main() -> Unit = {
  obsid.create_chunk(0)
  for x in 0..16 {
    for z in 0..16 {
      for y in 0..4 {
        obsid.set_block(0, x, y, z, if y == 3 then 1 else 2)
      }
    }
  }
  obsid.build_chunk(0, 0.0, 0.0, 0.0)
}

pub fn render_frame(time: Float) -> Unit = {
  obsid.set_camera(60.0, obsid.get_aspect(), 0.1, 100.0,
    obsid.sin(time * 0.3) * 20.0, 15.0, obsid.cos(time * 0.3) * 20.0,
    8.0, 2.0, 8.0)
  obsid.set_dir_light(1.0, 0.95, 0.9, 0.5, 1.0, 0.3)
  obsid.set_ambient(0.2, 0.2, 0.25)
  obsid.render()
}
```

Build and serve:

```bash
almide build src/main.almd --target wasm -o host/app.wasm
cd host && python3 -m http.server 8765
```

## API

### Chunks

```almide
obsid.create_chunk(id)                          // allocate 16³ block grid
obsid.set_block(chunk_id, x, y, z, block_type)  // place a block (0=air)
obsid.build_chunk(chunk_id, wx, wy, wz)         // mesh and upload to GPU
obsid.remove_chunk(chunk_id)                    // unload
obsid.set_chunk_visible(chunk_id, visible)      // show/hide
```

### Block Types

| ID | Type  | Top     | Side    |
|----|-------|---------|---------|
| 1  | Grass | green   | brown   |
| 2  | Stone | gray    | gray    |
| 3  | Dirt  | brown   | brown   |
| 4  | Sand  | yellow  | yellow  |
| 5  | Wood  | brown   | brown   |
| 6  | Leaves| green   | green   |
| 7  | Snow  | white   | white   |
| 8  | Water | blue    | blue    |

### Camera & Rendering

```almide
obsid.set_camera(fov, aspect, near, far, px, py, pz, tx, ty, tz)
obsid.get_aspect() -> Float                     // canvas width/height
obsid.set_dir_light(r, g, b, dx, dy, dz)       // directional light
obsid.set_ambient(r, g, b)                      // ambient light
obsid.set_fog(r, g, b, near, far)               // distance fog
obsid.render()                                  // draw frame
```

### Math

```almide
obsid.sin(x)  obsid.cos(x)  obsid.sqrt(x)  obsid.abs(x)
obsid.min(a, b)  obsid.max(a, b)  obsid.floor(x)  obsid.ceil(x)
obsid.pow(x, y)  obsid.pi()
obsid.to_float(i: Int) -> Float
obsid.to_int(f: Float) -> Int
```

### State

```almide
obsid.set_state(slot, value)    // persist Int across frames
obsid.get_state(slot) -> Int
obsid.set_state_f(slot, value)  // persist Float across frames
obsid.get_state_f(slot) -> Float
```

## Rendering Pipeline

1. WASM `main()` runs: creates chunks, fills blocks, calls `build_chunk()`
2. JS meshing: for each block, check 6 neighbors → emit visible faces with per-face AO and color noise
3. WASM `render_frame(time)` runs each frame: updates camera/lights, calls `render()`
4. JS rendering: iterate chunks, bind VBO/IBO, `drawElements()` — no scene graph traversal

Per-chunk cost: 1 uniform upload (`u_chunk_pos`) + 2 buffer binds + 1 draw call. Voxel chunks are axis-aligned → no model matrix multiplication.

## Almide Compiler Notes

Building for WASM requires `almide build src/main.almd --target wasm` (explicit file path, not project mode).

All `@extern(wasm, ...)` functions returning `Unit` require the compiler's DCE fix ([almide/almide@5de3c3c](https://github.com/almide/almide/commit/5de3c3ce)) to prevent dead-code elimination of FFI calls.
