// obsid — JS renderer for Almide 3D scene engine
//
// Usage:
//   const instance = await Obsid.load("app.wasm", "canvas");

const Obsid = {
  async load(wasmUrl, canvasEl) {
    const canvas = typeof canvasEl === "string" ? document.getElementById(canvasEl) : canvasEl;
    if (!canvas) throw new Error(`Canvas not found: ${canvasEl}`);
    const gl = canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL not supported");

    let memory;
    const objects = [null];
    const state = {};
    const N = (v) => Number(v);
    const B = (v) => BigInt(v ?? 0);
    function addObj(o) { objects.push(o); return B(objects.length - 1); }
    function getObj(id) { return objects[(typeof id === "bigint") ? N(id) : id]; }

    // ── Mat4 ──────────────────────────────────────────
    function mat4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
    function mat4Perspective(fov, aspect, near, far) {
      const f = 1 / Math.tan(fov * Math.PI / 360), nf = 1 / (near - far);
      return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
    }
    function mat4LookAt(eye, center, up) {
      let fx=center[0]-eye[0], fy=center[1]-eye[1], fz=center[2]-eye[2];
      let fl=Math.sqrt(fx*fx+fy*fy+fz*fz); fx/=fl; fy/=fl; fz/=fl;
      let sx=fy*up[2]-fz*up[1], sy=fz*up[0]-fx*up[2], sz=fx*up[1]-fy*up[0];
      let sl=Math.sqrt(sx*sx+sy*sy+sz*sz); sx/=sl; sy/=sl; sz/=sl;
      let ux=sy*fz-sz*fy, uy=sz*fx-sx*fz, uz=sx*fy-sy*fx;
      return new Float32Array([
        sx,ux,-fx,0, sy,uy,-fy,0, sz,uz,-fz,0,
        -(sx*eye[0]+sy*eye[1]+sz*eye[2]),
        -(ux*eye[0]+uy*eye[1]+uz*eye[2]),
        fx*eye[0]+fy*eye[1]+fz*eye[2], 1
      ]);
    }
    function mat4Mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k]; o[c*4+r] = s;
      }
      return o;
    }
    function mat4FromEuler(rx, ry, rz) {
      const cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
      // R = Rz * Ry * Rx, column-major
      return new Float32Array([
        cy*cz, cy*sz, -sy, 0,
        sx*sy*cz-cx*sz, sx*sy*sz+cx*cz, sx*cy, 0,
        cx*sy*cz+sx*sz, cx*sy*sz-sx*cz, cx*cy, 0,
        0, 0, 0, 1
      ]);
    }
    function mat4Translate(m, x, y, z) {
      const o = new Float32Array(m);
      o[12] = m[0]*x + m[4]*y + m[8]*z + m[12];
      o[13] = m[1]*x + m[5]*y + m[9]*z + m[13];
      o[14] = m[2]*x + m[6]*y + m[10]*z + m[14];
      o[15] = m[3]*x + m[7]*y + m[11]*z + m[15];
      return o;
    }
    function mat4Scale(m, x, y, z) {
      const o = new Float32Array(m);
      for (let i = 0; i < 4; i++) { o[i]*=x; o[4+i]*=y; o[8+i]*=z; }
      return o;
    }

    // ── Geometry Generators ───────────────────────────
    function createBoxGeo(w, h, d) {
      const hw=w/2,hh=h/2,hd=d/2;
      // 6 faces, 4 verts each: pos(3)+normal(3)
      const v = new Float32Array([
        // Front
        -hw,-hh,hd, 0,0,1,  hw,-hh,hd, 0,0,1,  hw,hh,hd, 0,0,1,  -hw,hh,hd, 0,0,1,
        // Back
        hw,-hh,-hd, 0,0,-1, -hw,-hh,-hd, 0,0,-1, -hw,hh,-hd, 0,0,-1, hw,hh,-hd, 0,0,-1,
        // Top
        -hw,hh,hd, 0,1,0,  hw,hh,hd, 0,1,0,  hw,hh,-hd, 0,1,0,  -hw,hh,-hd, 0,1,0,
        // Bottom
        -hw,-hh,-hd, 0,-1,0, hw,-hh,-hd, 0,-1,0, hw,-hh,hd, 0,-1,0, -hw,-hh,hd, 0,-1,0,
        // Right
        hw,-hh,hd, 1,0,0,  hw,-hh,-hd, 1,0,0,  hw,hh,-hd, 1,0,0,  hw,hh,hd, 1,0,0,
        // Left
        -hw,-hh,-hd, -1,0,0, -hw,-hh,hd, -1,0,0, -hw,hh,hd, -1,0,0, -hw,hh,-hd, -1,0,0,
      ]);
      const idx = new Uint16Array([
        0,1,2,0,2,3, 4,5,6,4,6,7, 8,9,10,8,10,11,
        12,13,14,12,14,15, 16,17,18,16,18,19, 20,21,22,20,22,23
      ]);
      return uploadGeo(v, idx);
    }

    function createPlaneGeo(w, h) {
      const hw=w/2, hh=h/2;
      const v = new Float32Array([
        -hw,0,-hh, 0,1,0,  hw,0,-hh, 0,1,0,  hw,0,hh, 0,1,0,  -hw,0,hh, 0,1,0,
      ]);
      const idx = new Uint16Array([0,1,2,0,2,3]);
      return uploadGeo(v, idx);
    }

    function createSphereGeo(radius, segs, rings) {
      const verts = [], indices = [];
      for (let r = 0; r <= rings; r++) {
        const phi = Math.PI * r / rings;
        for (let s = 0; s <= segs; s++) {
          const theta = 2 * Math.PI * s / segs;
          const nx = Math.sin(phi)*Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi)*Math.sin(theta);
          verts.push(nx*radius, ny*radius, nz*radius, nx, ny, nz);
        }
      }
      for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
        const a = r*(segs+1)+s, b = a+segs+1;
        indices.push(a,b,a+1, b,b+1,a+1);
      }
      return uploadGeo(new Float32Array(verts), new Uint16Array(indices));
    }

    function uploadGeo(verts, indices) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return { vbo, ibo, count: indices.length };
    }

    // ── Shader ────────────────────────────────────────
    const VS = `
      attribute vec3 a_pos;
      attribute vec3 a_norm;
      uniform mat4 u_mvp;
      uniform mat4 u_model;
      varying vec3 v_norm;
      varying vec3 v_pos;
      void main() {
        vec4 wp = u_model * vec4(a_pos, 1.0);
        v_pos = wp.xyz;
        v_norm = mat3(u_model) * a_norm;
        gl_Position = u_mvp * vec4(a_pos, 1.0);
      }
    `;
    const FS = `
      precision mediump float;
      varying vec3 v_norm;
      varying vec3 v_pos;
      uniform vec3 u_color;
      uniform vec3 u_dir_light_color;
      uniform vec3 u_dir_light_dir;
      uniform vec3 u_ambient;
      uniform int u_flat;
      void main() {
        if (u_flat == 1) { gl_FragColor = vec4(u_color, 1.0); return; }
        vec3 n = normalize(v_norm);
        vec3 l = normalize(u_dir_light_dir);
        float diff = max(dot(n, l), 0.0);
        vec3 color = u_color * u_ambient + u_color * u_dir_light_color * diff;
        gl_FragColor = vec4(color, 1.0);
      }
    `;
    let program, uMvp, uModel, uColor, uDirColor, uDirDir, uAmbient, uFlat, aPos, aNorm;

    function initShader() {
      const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VS); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vs));
      const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, FS); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fs));
      program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      uMvp = gl.getUniformLocation(program, "u_mvp");
      uModel = gl.getUniformLocation(program, "u_model");
      uColor = gl.getUniformLocation(program, "u_color");
      uDirColor = gl.getUniformLocation(program, "u_dir_light_color");
      uDirDir = gl.getUniformLocation(program, "u_dir_light_dir");
      uAmbient = gl.getUniformLocation(program, "u_ambient");
      uFlat = gl.getUniformLocation(program, "u_flat");
      aPos = gl.getAttribLocation(program, "a_pos");
      aNorm = gl.getAttribLocation(program, "a_norm");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aNorm);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
    }

    // ── Scene Graph ───────────────────────────────────
    class Obj3D {
      constructor(type) {
        this.type = type;
        this.pos = [0,0,0]; this.rot = [0,0,0]; this.scl = [1,1,1];
        this.children = []; this.target = null;
      }
    }

    function computeModelMatrix(obj) {
      // T * R * S: rotate+scale, then set translation
      const m = mat4Scale(
        mat4FromEuler(obj.rot[0], obj.rot[1], obj.rot[2]),
        obj.scl[0], obj.scl[1], obj.scl[2]
      );
      m[12] = obj.pos[0]; m[13] = obj.pos[1]; m[14] = obj.pos[2];
      return m;
    }

    function renderScene(scene, camera) {
      const bg = scene.bg || [0,0,0];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const eye = camera.pos;
      const target = camera.target || [0,0,0];
      const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
      const view = mat4LookAt(eye, target, [0,1,0]);
      const vp = mat4Mul(proj, view);

      // Collect lights
      let dirColor = [0,0,0], dirDir = [0.5,1,0.3], ambient = [0.1,0.1,0.1];
      function scanLights(obj) {
        if (obj.type === "dir_light") { dirColor = obj.color; dirDir = obj.dir; }
        if (obj.type === "ambient_light") { ambient = obj.color; }
        obj.children.forEach(scanLights);
      }
      scanLights(scene);
      gl.uniform3fv(uDirColor, dirColor);
      gl.uniform3fv(uDirDir, dirDir);
      gl.uniform3fv(uAmbient, ambient);

      function drawObj(obj) {
        if (obj.type === "mesh" && obj.geo && obj.mat) {
          const model = computeModelMatrix(obj);
          const mvp = mat4Mul(vp, model);
          gl.uniformMatrix4fv(uMvp, false, mvp);
          gl.uniformMatrix4fv(uModel, false, model);
          gl.uniform3fv(uColor, obj.mat.color);
          gl.uniform1i(uFlat, obj.mat.flat ? 1 : 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, obj.geo.vbo);
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
          gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 24, 12);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obj.geo.ibo);
          gl.drawElements(gl.TRIANGLES, obj.geo.count, gl.UNSIGNED_SHORT, 0);
        }
        obj.children.forEach(drawObj);
      }
      drawObj(scene);
    }

    // ── Imports ───────────────────────────────────────
    const imports = {
      obsid: {
        set_state(slot, value) { state[N(slot)] = N(value); },
        get_state(slot) { return B(state[N(slot)] ?? 0); },

        scene() {
          const s = new Obj3D("scene"); s.bg = [0,0,0];
          return addObj(s);
        },
        set_background(s, r, g, b) { getObj(s).bg = [r, g, b]; },

        perspective_camera(fov, aspect, near, far) {
          const c = new Obj3D("camera");
          c.fov = fov; c.aspect = aspect; c.near = near; c.far = far;
          c.target = [0,0,0];
          return addObj(c);
        },

        box_geo(w, h, d) { return addObj(createBoxGeo(w, h, d)); },
        sphere_geo(radius, segs, rings) { return addObj(createSphereGeo(radius, N(segs), N(rings))); },
        plane_geo(w, h) { return addObj(createPlaneGeo(w, h)); },

        color_mat(r, g, b) { return addObj({ color: [r,g,b], flat: false }); },
        flat_mat(r, g, b) { return addObj({ color: [r,g,b], flat: true }); },

        mesh(geo, mat) {
          const m = new Obj3D("mesh");
          m.geo = getObj(geo); m.mat = getObj(mat);
          return addObj(m);
        },

        add(parent, child) { getObj(parent).children.push(getObj(child)); },
        set_position(o, x, y, z) { getObj(o).pos = [x, y, z]; },
        set_rotation(o, x, y, z) { getObj(o).rot = [x, y, z]; },
        set_scale(o, x, y, z) { getObj(o).scl = [x, y, z]; },
        look_at(o, x, y, z) { getObj(o).target = [x, y, z]; },

        directional_light(r, g, b, x, y, z) {
          const l = new Obj3D("dir_light"); l.color = [r,g,b]; l.dir = [x,y,z];
          return addObj(l);
        },
        ambient_light(r, g, b) {
          const l = new Obj3D("ambient_light"); l.color = [r,g,b];
          return addObj(l);
        },

        render(scene, camera) { renderScene(getObj(scene), getObj(camera)); },
      },

      wasi_snapshot_preview1: {
        fd_write(fd, iovs, iovs_len, nwritten_ptr) {
          const view = new DataView(memory.buffer);
          let written = 0, output = "";
          for (let i = 0; i < iovs_len; i++) {
            const ptr = view.getInt32(iovs + i * 8, true);
            const len = view.getInt32(iovs + i * 8 + 4, true);
            output += new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
            written += len;
          }
          if (fd === 1) console.log(output.trimEnd());
          else if (fd === 2) console.error(output.trimEnd());
          view.setInt32(nwritten_ptr, written, true);
          return 0;
        },
        clock_time_get(id, prec, ptr) {
          new DataView(memory.buffer).setBigInt64(ptr, BigInt(Math.floor(performance.now()*1e6)), true);
          return 0;
        },
        proc_exit(c) { if (c !== 0) console.error(`exit(${c})`); },
        random_get(buf, len) { crypto.getRandomValues(new Uint8Array(memory.buffer, buf, len)); return 0; },
        path_open() { return 76; }, fd_read() { return 76; }, fd_close() { return 0; },
        fd_seek() { return 76; }, fd_filestat_get() { return 76; },
        path_filestat_get() { return 76; }, path_create_directory() { return 76; },
        path_rename() { return 76; }, path_unlink_file() { return 76; },
        path_remove_directory() { return 76; }, fd_prestat_get() { return 8; },
        fd_prestat_dir_name() { return 8; }, fd_readdir() { return 76; },
      },
    };

    const { instance } = await WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), imports);
    memory = instance.exports.memory;
    initShader();

    if (instance.exports._start) instance.exports._start();

    if (instance.exports.render_frame) {
      let start = null;
      (function animate(ts) {
        if (!start) start = ts;
        instance.exports.render_frame((ts - start) / 1000);
        requestAnimationFrame(animate);
      })(performance.now());
    }

    return instance;
  },
};
