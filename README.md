# obsid

Graphics runtime for [Almide](https://github.com/almide/almide) — Canvas 2D, WebGL, and 3D mesh rendering via WASM.

## Modules

| Module | What | Use when |
|---|---|---|
| `obsid.canvas` | Canvas 2D API bindings | 2D drawing, charts, UI |
| `obsid.webgl` | WebGL 1.0 API bindings | Custom shaders, low-level 3D |
| `obsid` | 3D mesh renderer | Scene graph, orbit camera, lighting |

Pure math (vec3, mat4, color) lives in [lumen](https://github.com/almide/lumen).

## Usage

### Canvas 2D

```almide
import obsid.canvas as canvas

effect fn main() -> Unit = {
  canvas.set_fill_style("#4A90D9")
  canvas.fill_rect(10.0, 10.0, 200.0, 100.0)
}
```

### WebGL

```almide
import obsid.webgl as gl
import lumen.mat4 as mat

effect fn render_frame(time: Float) -> Unit = {
  gl.clear(gl.color_buffer_bit() + gl.depth_buffer_bit())
  let model = mat.identity() |> mat.rotate_y(time)
  // ...
}
```

### 3D Renderer

```almide
import obsid

effect fn main() -> Unit = {
  obsid.create_mesh(0)
  obsid.upload_mesh(0, vert_ptr, vert_count, idx_ptr, idx_count)
  obsid.set_camera(0.785, 1.333, 0.1, 100.0, 0.0, 2.0, 5.0, 0.0, 0.0, 0.0)
}
```

## Building

```bash
almide build examples/canvas-demo.almd --target wasm
almide build examples/cube.almd --target wasm
almide build examples/sphere.almd --target wasm
```

## Structure

```
src/
  mod.almd          3D renderer bindings + orbit camera
  canvas.almd       Canvas 2D API bindings
  webgl.almd        WebGL 1.0 API bindings
host/
  obsid.js          3D renderer JS runtime
  canvas.js         Canvas 2D JS glue
  webgl.js          WebGL JS glue
examples/
  canvas-demo.almd  Canvas 2D drawing
  cube.almd         WebGL rotating cube
  sphere.almd       3D procedural sphere
```

## Dependencies

- [lumen](https://github.com/almide/lumen) — vec3, mat4, color

## License

MIT
