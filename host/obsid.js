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
    const stateF = {};
    const N = (v) => Number(v);
    const B = (v) => BigInt(v ?? 0);
    function addObj(o) { objects.push(o); return B(objects.length - 1); }
    function getObj(id) { return objects[(typeof id === "bigint") ? N(id) : id] || null; }

    // ── Mat4 ──────────────────────────────────────────
    const I = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

    function mat4Perspective(fov, aspect, near, far) {
      const f = 1 / Math.tan(fov * Math.PI / 360), nf = 1 / (near - far);
      return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
    }

    function mat4Ortho(l, r, b, t, near, far) {
      const rl = 1/(r-l), tb = 1/(t-b), nf = 1/(near-far);
      return new Float32Array([
        2*rl, 0, 0, 0,
        0, 2*tb, 0, 0,
        0, 0, 2*nf, 0,
        -(r+l)*rl, -(t+b)*tb, (far+near)*nf, 1
      ]);
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
      return new Float32Array([
        cy*cz, cy*sz, -sy, 0,
        sx*sy*cz-cx*sz, sx*sy*sz+cx*cz, sx*cy, 0,
        cx*sy*cz+sx*sz, cx*sy*sz-sx*cz, cx*cy, 0,
        0, 0, 0, 1
      ]);
    }

    function mat4Scale(m, x, y, z) {
      const o = new Float32Array(m);
      for (let i = 0; i < 4; i++) { o[i]*=x; o[4+i]*=y; o[8+i]*=z; }
      return o;
    }

    // ── Geometry Generators ───────────────────────────
    function uploadGeo(verts, indices) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return { vbo, ibo, count: indices.length };
    }

    function createBoxGeo(w, h, d) {
      const hw=w/2,hh=h/2,hd=d/2;
      const v = new Float32Array([
        -hw,-hh,hd, 0,0,1,  hw,-hh,hd, 0,0,1,  hw,hh,hd, 0,0,1,  -hw,hh,hd, 0,0,1,
        hw,-hh,-hd, 0,0,-1, -hw,-hh,-hd, 0,0,-1, -hw,hh,-hd, 0,0,-1, hw,hh,-hd, 0,0,-1,
        -hw,hh,hd, 0,1,0,  hw,hh,hd, 0,1,0,  hw,hh,-hd, 0,1,0,  -hw,hh,-hd, 0,1,0,
        -hw,-hh,-hd, 0,-1,0, hw,-hh,-hd, 0,-1,0, hw,-hh,hd, 0,-1,0, -hw,-hh,hd, 0,-1,0,
        hw,-hh,hd, 1,0,0,  hw,-hh,-hd, 1,0,0,  hw,hh,-hd, 1,0,0,  hw,hh,hd, 1,0,0,
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
      return uploadGeo(v, new Uint16Array([0,1,2,0,2,3]));
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

    function createCylinderGeo(rTop, rBot, h, segs) {
      const verts = [], indices = [];
      const halfH = h / 2, hSegs = 1;
      const dr = rBot - rTop;
      const len = Math.sqrt(dr * dr + h * h);
      const ny = dr / len, nr = h / len;

      // Body
      for (let y = 0; y <= hSegs; y++) {
        const v = y / hSegs;
        const r = rBot + (rTop - rBot) * v;
        const py = -halfH + h * v;
        for (let s = 0; s <= segs; s++) {
          const theta = (s / segs) * Math.PI * 2;
          const c = Math.cos(theta), si = Math.sin(theta);
          verts.push(r*c, py, r*si, c*nr, ny, si*nr);
        }
      }
      for (let y = 0; y < hSegs; y++) for (let s = 0; s < segs; s++) {
        const a = y*(segs+1)+s, b = a+segs+1;
        indices.push(a, b, a+1, b, b+1, a+1);
      }

      // Top cap
      if (rTop > 0) {
        const ci = verts.length / 6;
        verts.push(0, halfH, 0, 0, 1, 0);
        for (let s = 0; s <= segs; s++) {
          const t = (s / segs) * Math.PI * 2;
          verts.push(rTop*Math.cos(t), halfH, rTop*Math.sin(t), 0, 1, 0);
        }
        for (let s = 0; s < segs; s++) indices.push(ci, ci+1+s, ci+2+s);
      }

      // Bottom cap
      if (rBot > 0) {
        const ci = verts.length / 6;
        verts.push(0, -halfH, 0, 0, -1, 0);
        for (let s = 0; s <= segs; s++) {
          const t = (s / segs) * Math.PI * 2;
          verts.push(rBot*Math.cos(t), -halfH, rBot*Math.sin(t), 0, -1, 0);
        }
        for (let s = 0; s < segs; s++) indices.push(ci, ci+2+s, ci+1+s);
      }

      return uploadGeo(new Float32Array(verts), new Uint16Array(indices));
    }

    function createTorusGeo(radius, tube, radSegs, tubSegs) {
      const verts = [], indices = [];
      for (let j = 0; j <= radSegs; j++) {
        for (let i = 0; i <= tubSegs; i++) {
          const u = (i / tubSegs) * Math.PI * 2;
          const v = (j / radSegs) * Math.PI * 2;
          const x = (radius + tube*Math.cos(u)) * Math.cos(v);
          const y = tube * Math.sin(u);
          const z = (radius + tube*Math.cos(u)) * Math.sin(v);
          const cx = radius * Math.cos(v), cz = radius * Math.sin(v);
          let nx = x-cx, ny = y, nz = z-cz;
          const nl = Math.sqrt(nx*nx+ny*ny+nz*nz);
          verts.push(x, y, z, nx/nl, ny/nl, nz/nl);
        }
      }
      for (let j = 0; j < radSegs; j++) for (let i = 0; i < tubSegs; i++) {
        const a = j*(tubSegs+1)+i, b = a+tubSegs+1;
        indices.push(a, b, a+1, b, b+1, a+1);
      }
      return uploadGeo(new Float32Array(verts), new Uint16Array(indices));
    }

    function createCircleGeo(radius, segs) {
      const verts = [0, 0, 0, 0, 1, 0];
      for (let s = 0; s <= segs; s++) {
        const t = (s / segs) * Math.PI * 2;
        verts.push(radius*Math.cos(t), 0, radius*Math.sin(t), 0, 1, 0);
      }
      const indices = [];
      for (let s = 0; s < segs; s++) indices.push(0, s+1, s+2);
      return uploadGeo(new Float32Array(verts), new Uint16Array(indices));
    }

    function createRingGeo(inner, outer, segs) {
      const verts = [], indices = [];
      for (let s = 0; s <= segs; s++) {
        const t = (s / segs) * Math.PI * 2;
        const c = Math.cos(t), si = Math.sin(t);
        verts.push(inner*c, 0, inner*si, 0, 1, 0);
        verts.push(outer*c, 0, outer*si, 0, 1, 0);
      }
      for (let s = 0; s < segs; s++) {
        const a = s*2, b = a+1, c = a+2, d = a+3;
        indices.push(a, c, b, b, c, d);
      }
      return uploadGeo(new Float32Array(verts), new Uint16Array(indices));
    }

    // ── Shader ────────────────────────────────────────
    const MAX_DIR = 2, MAX_PT = 4;

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
      uniform int u_shading;      // 0=flat 1=lambert 2=phong
      uniform float u_shininess;
      uniform vec3 u_specular;
      uniform float u_opacity;
      uniform vec3 u_eye;
      uniform vec3 u_ambient;

      uniform int u_num_dir;
      uniform vec3 u_dir_color[${MAX_DIR}];
      uniform vec3 u_dir_dir[${MAX_DIR}];

      uniform int u_num_pt;
      uniform vec3 u_pt_color[${MAX_PT}];
      uniform vec3 u_pt_pos[${MAX_PT}];
      uniform float u_pt_range[${MAX_PT}];

      uniform int u_has_hemi;
      uniform vec3 u_hemi_sky;
      uniform vec3 u_hemi_ground;

      uniform int u_fog_type;     // 0=none 1=linear 2=exp2
      uniform vec3 u_fog_color;
      uniform float u_fog_near;
      uniform float u_fog_far;
      uniform float u_fog_density;

      void main() {
        if (u_shading == 0) {
          gl_FragColor = vec4(u_color, u_opacity);
          return;
        }

        vec3 n = normalize(v_norm);
        vec3 vd = normalize(u_eye - v_pos);
        vec3 light = u_ambient;
        vec3 spec = vec3(0.0);

        // Hemisphere
        if (u_has_hemi == 1) {
          float hm = n.y * 0.5 + 0.5;
          light += mix(u_hemi_ground, u_hemi_sky, hm);
        }

        // Directional
        for (int i = 0; i < ${MAX_DIR}; i++) {
          if (i >= u_num_dir) break;
          vec3 ld = normalize(u_dir_dir[i]);
          float diff = max(dot(n, ld), 0.0);
          light += u_dir_color[i] * diff;
          if (u_shading == 2) {
            vec3 h = normalize(ld + vd);
            spec += u_dir_color[i] * pow(max(dot(n, h), 0.0), u_shininess);
          }
        }

        // Point
        for (int i = 0; i < ${MAX_PT}; i++) {
          if (i >= u_num_pt) break;
          vec3 toL = u_pt_pos[i] - v_pos;
          float dist = length(toL);
          vec3 ld = toL / dist;
          float atten = 1.0;
          if (u_pt_range[i] > 0.0) {
            atten = clamp(1.0 - dist / u_pt_range[i], 0.0, 1.0);
            atten *= atten;
          }
          float diff = max(dot(n, ld), 0.0);
          light += u_pt_color[i] * diff * atten;
          if (u_shading == 2) {
            vec3 h = normalize(ld + vd);
            spec += u_pt_color[i] * pow(max(dot(n, h), 0.0), u_shininess) * atten;
          }
        }

        vec3 color = u_color * light + u_specular * spec;

        // Fog
        if (u_fog_type > 0) {
          float fd = length(u_eye - v_pos);
          float ff;
          if (u_fog_type == 1) {
            ff = clamp((u_fog_far - fd) / (u_fog_far - u_fog_near), 0.0, 1.0);
          } else {
            float e = fd * u_fog_density;
            ff = clamp(exp(-e * e), 0.0, 1.0);
          }
          color = mix(u_fog_color, color, ff);
        }

        gl_FragColor = vec4(color, u_opacity);
      }
    `;

    let program, aPos, aNorm;
    let uMvp, uModel, uColor, uShading, uShininess, uSpecular, uOpacity, uEye, uAmbient;
    let uNumDir, uDirColor, uDirDir;
    let uNumPt, uPtColor, uPtPos, uPtRange;
    let uHasHemi, uHemiSky, uHemiGround;
    let uFogType, uFogColor, uFogNear, uFogFar, uFogDensity;

    function initShader() {
      const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VS); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vs));
      const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, FS); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fs));
      program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
      gl.useProgram(program);

      const u = (n) => gl.getUniformLocation(program, n);
      uMvp = u("u_mvp"); uModel = u("u_model");
      uColor = u("u_color"); uShading = u("u_shading");
      uShininess = u("u_shininess"); uSpecular = u("u_specular");
      uOpacity = u("u_opacity"); uEye = u("u_eye"); uAmbient = u("u_ambient");

      uNumDir = u("u_num_dir");
      uDirColor = []; uDirDir = [];
      for (let i = 0; i < MAX_DIR; i++) {
        uDirColor.push(u(`u_dir_color[${i}]`));
        uDirDir.push(u(`u_dir_dir[${i}]`));
      }
      uNumPt = u("u_num_pt");
      uPtColor = []; uPtPos = []; uPtRange = [];
      for (let i = 0; i < MAX_PT; i++) {
        uPtColor.push(u(`u_pt_color[${i}]`));
        uPtPos.push(u(`u_pt_pos[${i}]`));
        uPtRange.push(u(`u_pt_range[${i}]`));
      }
      uHasHemi = u("u_has_hemi"); uHemiSky = u("u_hemi_sky"); uHemiGround = u("u_hemi_ground");
      uFogType = u("u_fog_type"); uFogColor = u("u_fog_color");
      uFogNear = u("u_fog_near"); uFogFar = u("u_fog_far"); uFogDensity = u("u_fog_density");

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
        this.visible = true;
      }
    }

    function computeModel(obj) {
      const m = mat4Scale(
        mat4FromEuler(obj.rot[0], obj.rot[1], obj.rot[2]),
        obj.scl[0], obj.scl[1], obj.scl[2]
      );
      m[12] = obj.pos[0]; m[13] = obj.pos[1]; m[14] = obj.pos[2];
      return m;
    }

    // ── Render ────────────────────────────────────────
    function renderScene(scene, camera) {
      const bg = scene.bg || [0,0,0];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const eye = camera.pos;
      const target = camera.target || [0,0,0];
      const proj = camera.ortho
        ? mat4Ortho(camera.left, camera.right, camera.bottom, camera.top, camera.near, camera.far)
        : mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
      const view = mat4LookAt(eye, target, [0,1,0]);
      const vp = mat4Mul(proj, view);

      // Collect lights & meshes in one traversal
      const dirL = [], ptL = [];
      let amb = [0,0,0], hemi = null;
      const opaque = [], transp = [];

      function collect(obj, parentMat) {
        if (!obj.visible) return;
        const local = computeModel(obj);
        const world = parentMat ? mat4Mul(parentMat, local) : local;

        switch (obj.type) {
          case "dir_light":
            dirL.push(obj); break;
          case "point_light":
            ptL.push({ color: obj.color, range: obj.range,
                        pos: [world[12], world[13], world[14]] }); break;
          case "ambient_light":
            amb[0] += obj.color[0]; amb[1] += obj.color[1]; amb[2] += obj.color[2]; break;
          case "hemi_light":
            hemi = obj; break;
          case "mesh":
            if (obj.geo && obj.mat) {
              const e = { obj, world };
              if (obj.mat.opacity < 1) {
                const dx=world[12]-eye[0], dy=world[13]-eye[1], dz=world[14]-eye[2];
                e.dist = dx*dx+dy*dy+dz*dz;
                transp.push(e);
              } else {
                opaque.push(e);
              }
            }
            break;
        }
        obj.children.forEach(c => collect(c, world));
      }
      collect(scene, null);

      // Upload light uniforms
      gl.uniform3fv(uEye, eye);
      gl.uniform3fv(uAmbient, amb);

      const nd = Math.min(dirL.length, MAX_DIR);
      gl.uniform1i(uNumDir, nd);
      for (let i = 0; i < nd; i++) {
        gl.uniform3fv(uDirColor[i], dirL[i].color);
        gl.uniform3fv(uDirDir[i], dirL[i].dir);
      }

      const np = Math.min(ptL.length, MAX_PT);
      gl.uniform1i(uNumPt, np);
      for (let i = 0; i < np; i++) {
        gl.uniform3fv(uPtColor[i], ptL[i].color);
        gl.uniform3fv(uPtPos[i], ptL[i].pos);
        gl.uniform1f(uPtRange[i], ptL[i].range);
      }

      if (hemi) {
        gl.uniform1i(uHasHemi, 1);
        gl.uniform3fv(uHemiSky, hemi.sky);
        gl.uniform3fv(uHemiGround, hemi.ground);
      } else {
        gl.uniform1i(uHasHemi, 0);
      }

      // Fog
      const fog = scene.fog;
      if (fog) {
        gl.uniform1i(uFogType, fog.type);
        gl.uniform3fv(uFogColor, fog.color);
        gl.uniform1f(uFogNear, fog.near || 0);
        gl.uniform1f(uFogFar, fog.far || 100);
        gl.uniform1f(uFogDensity, fog.density || 0);
      } else {
        gl.uniform1i(uFogType, 0);
      }

      // Draw helper
      function draw(entry) {
        const { obj, world } = entry;
        const mvp = mat4Mul(vp, world);
        gl.uniformMatrix4fv(uMvp, false, mvp);
        gl.uniformMatrix4fv(uModel, false, world);
        gl.uniform3fv(uColor, obj.mat.color);
        gl.uniform1i(uShading, obj.mat.shading);
        gl.uniform1f(uShininess, obj.mat.shininess);
        gl.uniform3fv(uSpecular, obj.mat.specular);
        gl.uniform1f(uOpacity, obj.mat.opacity);
        gl.bindBuffer(gl.ARRAY_BUFFER, obj.geo.vbo);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 24, 12);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obj.geo.ibo);
        gl.drawElements(gl.TRIANGLES, obj.geo.count, gl.UNSIGNED_SHORT, 0);
      }

      // Opaque pass
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      opaque.forEach(draw);

      // Transparent pass (back to front)
      if (transp.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        transp.sort((a, b) => b.dist - a.dist);
        transp.forEach(draw);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }

    // ── Material helpers ──────────────────────────────
    function makeMat(color, shading) {
      return { color, shading, shininess: 30, specular: [1,1,1], opacity: 1.0 };
    }

    // ── Imports ───────────────────────────────────────
    const imports = {
      obsid: {
        // State
        set_state(slot, value) { state[N(slot)] = N(value); },
        get_state(slot) { return B(state[N(slot)] ?? 0); },
        set_state_f(slot, value) { stateF[N(slot)] = value; },
        get_state_f(slot) { return stateF[N(slot)] ?? 0.0; },

        // Scene
        scene() { const s = new Obj3D("scene"); s.bg = [0,0,0]; return addObj(s); },
        set_background(s, r, g, b) { getObj(s).bg = [r, g, b]; },

        // Fog
        set_fog(s, r, g, b, near, far) {
          getObj(s).fog = { type: 1, color: [r,g,b], near, far };
        },
        set_fog_exp2(s, r, g, b, density) {
          getObj(s).fog = { type: 2, color: [r,g,b], density };
        },

        // Camera
        perspective_camera(fov, aspect, near, far) {
          const c = new Obj3D("camera");
          c.fov = fov; c.aspect = aspect; c.near = near; c.far = far;
          c.target = [0,0,0];
          return addObj(c);
        },
        orthographic_camera(left, right, top, bottom, near, far) {
          const c = new Obj3D("camera");
          c.ortho = true;
          c.left = left; c.right = right; c.top = top; c.bottom = bottom;
          c.near = near; c.far = far;
          c.target = [0,0,0];
          return addObj(c);
        },

        // Geometry
        box_geo(w, h, d) { return addObj(createBoxGeo(w, h, d)); },
        sphere_geo(r, segs, rings) { return addObj(createSphereGeo(r, N(segs), N(rings))); },
        plane_geo(w, h) { return addObj(createPlaneGeo(w, h)); },
        cylinder_geo(rTop, rBot, h, segs) { return addObj(createCylinderGeo(rTop, rBot, h, N(segs))); },
        cone_geo(r, h, segs) { return addObj(createCylinderGeo(0, r, h, N(segs))); },
        torus_geo(r, tube, radSegs, tubSegs) { return addObj(createTorusGeo(r, tube, N(radSegs), N(tubSegs))); },
        circle_geo(r, segs) { return addObj(createCircleGeo(r, N(segs))); },
        ring_geo(inner, outer, segs) { return addObj(createRingGeo(inner, outer, N(segs))); },

        // Material
        color_mat(r, g, b) { return addObj(makeMat([r,g,b], 1)); },
        flat_mat(r, g, b) { return addObj(makeMat([r,g,b], 0)); },
        phong_mat(r, g, b, shininess) {
          const m = makeMat([r,g,b], 2);
          m.shininess = shininess;
          return addObj(m);
        },
        set_color(o, r, g, b) { getObj(o).color = [r,g,b]; },
        set_specular(o, r, g, b) { getObj(o).specular = [r,g,b]; },
        set_opacity(o, v) { getObj(o).opacity = v; },
        set_shininess(o, v) { getObj(o).shininess = v; },

        // Mesh
        mesh(geo, mat) {
          const m = new Obj3D("mesh");
          m.geo = getObj(geo); m.mat = getObj(mat);
          return addObj(m);
        },

        // Object3D
        group() { return addObj(new Obj3D("group")); },
        add(parent, child) { const p = getObj(parent), c = getObj(child); if(p && c) p.children.push(c); },
        remove(parent, child) {
          const p = getObj(parent), c = getObj(child);
          if(!p || !c) return;
          const i = p.children.indexOf(c);
          if (i !== -1) p.children.splice(i, 1);
        },
        set_position(o, x, y, z) { const obj = getObj(o); if(obj) obj.pos = [x, y, z]; },
        set_rotation(o, x, y, z) { const obj = getObj(o); if(obj) obj.rot = [x, y, z]; },
        set_scale(o, x, y, z) { const obj = getObj(o); if(obj) obj.scl = [x, y, z]; },
        look_at(o, x, y, z) { const obj = getObj(o); if(obj) obj.target = [x, y, z]; },
        set_visible(o, v) { const obj = getObj(o); if(obj) obj.visible = N(v) !== 0; },

        // Lights
        directional_light(r, g, b, x, y, z) {
          const l = new Obj3D("dir_light"); l.color = [r,g,b]; l.dir = [x,y,z];
          return addObj(l);
        },
        ambient_light(r, g, b) {
          const l = new Obj3D("ambient_light"); l.color = [r,g,b];
          return addObj(l);
        },
        point_light(r, g, b, range) {
          const l = new Obj3D("point_light"); l.color = [r,g,b]; l.range = range;
          return addObj(l);
        },
        hemisphere_light(skyR, skyG, skyB, gndR, gndG, gndB) {
          const l = new Obj3D("hemi_light");
          l.sky = [skyR, skyG, skyB]; l.ground = [gndR, gndG, gndB];
          return addObj(l);
        },

        // Math
        sin(x) { return Math.sin(x); },
        cos(x) { return Math.cos(x); },
        sqrt(x) { return Math.sqrt(x); },
        atan2(y, x) { return Math.atan2(y, x); },
        abs(x) { return Math.abs(x); },
        min(a, b) { return Math.min(a, b); },
        max(a, b) { return Math.max(a, b); },
        floor(x) { return Math.floor(x); },
        ceil(x) { return Math.ceil(x); },
        pow(x, y) { return Math.pow(x, y); },
        pi() { return Math.PI; },

        // Render
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
      function animate(ts) {
        if (!start) start = ts;
        try { instance.exports.render_frame((ts - start) / 1000); }
        catch(e) { console.warn("render_frame:", e.message); }
        requestAnimationFrame(animate);
      }
      requestAnimationFrame(animate);
    }

    return instance;
  },
};
