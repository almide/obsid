# almide/obsid

3D scene engine for [Almide](https://github.com/almide/almide) — Three.js-inspired, powered by `@extern(wasm)`.

**3.8 KB** WASM for a lit scene with multiple rotating objects. The scene description and animation logic compile to WASM; the renderer lives in a JS host.

## Install

```bash
almide add almide/obsid@v0.1.0
```

## Quick Start

```almide
import obsid

effect fn main() -> Unit = {
  let scene = obsid.scene()
  obsid.set_background(scene, 0.06, 0.06, 0.1)

  let camera = obsid.perspective_camera(60.0, 1.333, 0.1, 100.0)
  obsid.set_position(camera, 0.0, 3.0, 7.0)
  obsid.look_at(camera, 0.0, 0.5, 0.0)

  // Lighting
  obsid.add(scene, obsid.directional_light(1.0, 0.95, 0.9, 0.5, 1.0, 0.3))
  obsid.add(scene, obsid.ambient_light(0.15, 0.15, 0.2))

  // Mesh = Geometry + Material
  let cube = obsid.mesh(
    obsid.box_geo(1.5, 1.5, 1.5),
    obsid.color_mat(0.91, 0.27, 0.33),
  )
  obsid.set_position(cube, 0.0, 0.75, 0.0)
  obsid.add(scene, cube)

  obsid.set_state(0, scene)
  obsid.set_state(1, camera)
  obsid.set_state(2, cube)
}

// Called every frame by the JS animation loop
fn render_frame(time: Float) -> Unit = {
  obsid.set_rotation(obsid.get_state(2), time * 0.5, time * 0.7, 0.0)
  obsid.render(obsid.get_state(0), obsid.get_state(1))
}
```

**Build and serve:**

```bash
almide build app.almd --target wasm -o host/app.wasm
```

```html
<canvas id="canvas" width="800" height="600"></canvas>
<script src="obsid.js"></script>
<script>Obsid.load("app.wasm", "canvas");</script>
```

## API

### Scene

```almide
obsid.scene()                                              // create scene
obsid.set_background(scene, r, g, b)                      // background color
obsid.add(parent, child)                                   // add object to scene
```

### Camera

```almide
obsid.perspective_camera(fov, aspect, near, far)           // create camera
obsid.set_position(camera, x, y, z)
obsid.look_at(camera, x, y, z)
```

### Geometry

```almide
obsid.box_geo(w, h, d)                                    // box
obsid.sphere_geo(radius, segments, rings)                  // UV sphere
obsid.plane_geo(w, h)                                     // ground plane (XZ)
```

### Material

```almide
obsid.color_mat(r, g, b)                                  // Lambert shading
obsid.flat_mat(r, g, b)                                   // unlit flat color
```

### Mesh

```almide
obsid.mesh(geometry, material)                             // create mesh
obsid.set_position(obj, x, y, z)
obsid.set_rotation(obj, rx, ry, rz)                        // euler angles (radians)
obsid.set_scale(obj, sx, sy, sz)
```

### Lights

```almide
obsid.directional_light(r, g, b, dir_x, dir_y, dir_z)     // sun-like
obsid.ambient_light(r, g, b)                               // fill light
```

### Rendering

```almide
obsid.render(scene, camera)                                // draw frame
```

### State

Cross-function state for sharing handles between `main` and `render_frame`:

```almide
obsid.set_state(slot, value)                               // store integer
obsid.get_state(slot)                                      // retrieve integer
```

## Architecture

```
Almide code (scene description + animation logic)
  ↓ compile
WASM binary (3.8 KB) — @extern(wasm, "obsid", ...) imports
  ↓ load
host/obsid.js — scene graph, geometry generators, Lambert shader, WebGL renderer
  ↓ render
Browser GPU
```

The WASM binary contains only your scene logic. The JS host (~300 lines) handles all WebGL rendering, matrix math, and geometry generation. This separation keeps WASM binaries tiny while providing full 3D capabilities.
