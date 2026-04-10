// obsid — 3D rendering foundation for Almide
//
// Built on obsid-gl (thin WebGL WASM bridge).
// Features: mesh with full TRS transform, Phong shading (diffuse + specular),
// directional + multiple point lights, fog, transparency.
//
// Usage:
//   <script src="obsid-gl.js"></script>
//   <script src="obsid.js"></script>
//   <script>Obsid.load("app.wasm", "canvas")</script>

const Obsid = {
  async load(wasmUrl, canvasEl) {
    const { gl, canvas } = ObsidGL.init(canvasEl);

    let memory;
    const state = {}, stateF = {};
    const N = (v) => Number(v);
    const B = (v) => BigInt(v ?? 0);

    // ── Mat4 ──────────────────────────────────────────
    function mat4Perspective(fov, aspect, near, far) {
      const f = 1 / Math.tan(fov * Math.PI / 360), nf = 1 / (near - far);
      return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
    }
    function mat4LookAt(eye, center, up) {
      let fx=center[0]-eye[0],fy=center[1]-eye[1],fz=center[2]-eye[2];
      let fl=Math.hypot(fx,fy,fz); fx/=fl;fy/=fl;fz/=fl;
      let sx=fy*up[2]-fz*up[1],sy=fz*up[0]-fx*up[2],sz=fx*up[1]-fy*up[0];
      let sl=Math.hypot(sx,sy,sz); sx/=sl;sy/=sl;sz/=sl;
      let ux=sy*fz-sz*fy,uy=sz*fx-sx*fz,uz=sx*fy-sy*fx;
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
        let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r]*b[c*4+k]; o[c*4+r] = s;
      }
      return o;
    }
    // T * R * S where R = Rz * Ry * Rx (column-major)
    function mat4ComposeTRS(pos, rot, scl) {
      const cx=Math.cos(rot[0]), six=Math.sin(rot[0]);
      const cy=Math.cos(rot[1]), siy=Math.sin(rot[1]);
      const cz=Math.cos(rot[2]), siz=Math.sin(rot[2]);
      const sx=scl[0], sy=scl[1], sz=scl[2];
      return new Float32Array([
        (cy*cz)*sx,                  (cy*siz)*sx,                 (-siy)*sx,   0,
        (six*siy*cz - cx*siz)*sy,    (six*siy*siz + cx*cz)*sy,    (six*cy)*sy, 0,
        (cx*siy*cz + six*siz)*sz,    (cx*siy*siz - six*cz)*sz,    (cx*cy)*sz,  0,
        pos[0], pos[1], pos[2], 1
      ]);
    }

    // ── Shader ────────────────────────────────────────
    const MAX_POINTS = 4;
    const VS = `
      precision mediump float;
      attribute vec3 a_pos, a_norm, a_color;
      uniform mat4 u_vp;
      uniform mat4 u_model;
      uniform vec3 u_eye;
      varying vec3 v_norm, v_color, v_wpos;
      varying float v_dist;
      void main() {
        vec4 world = u_model * vec4(a_pos, 1.0);
        v_wpos = world.xyz;
        v_norm = mat3(u_model) * a_norm;
        v_color = a_color;
        v_dist = length(v_wpos - u_eye);
        gl_Position = u_vp * world;
      }
    `;
    const FS = `
      precision mediump float;
      varying vec3 v_norm, v_color, v_wpos;
      varying float v_dist;
      uniform vec3 u_eye;
      uniform vec3 u_sun_color, u_sun_dir, u_ambient, u_fog_color;
      uniform vec2 u_fog_range;
      uniform float u_shininess;
      uniform vec3 u_specular;
      uniform float u_alpha;
      uniform int u_num_points;
      uniform vec3 u_point_pos[${MAX_POINTS}];
      uniform vec3 u_point_color[${MAX_POINTS}];
      uniform float u_point_range[${MAX_POINTS}];
      void main() {
        vec3 n = normalize(v_norm);
        vec3 viewDir = normalize(u_eye - v_wpos);

        // Directional (sun) — Lambert + Blinn-Phong
        vec3 sunDir = normalize(u_sun_dir);
        float sunDiff = max(dot(n, sunDir), 0.0);
        vec3 sunHalf = normalize(sunDir + viewDir);
        float sunSpec = sunDiff > 0.0 ? pow(max(dot(n, sunHalf), 0.0), u_shininess) : 0.0;
        vec3 lighting = u_ambient + u_sun_color * sunDiff;
        vec3 specular = u_sun_color * sunSpec;

        // Point lights
        for (int i = 0; i < ${MAX_POINTS}; i++) {
          if (i >= u_num_points) break;
          vec3 toLight = u_point_pos[i] - v_wpos;
          float dist = length(toLight);
          vec3 dir = toLight / dist;
          float atten = clamp(1.0 - dist / u_point_range[i], 0.0, 1.0);
          atten *= atten;
          float diff = max(dot(n, dir), 0.0);
          vec3 half_v = normalize(dir + viewDir);
          float spec = diff > 0.0 ? pow(max(dot(n, half_v), 0.0), u_shininess) : 0.0;
          lighting += u_point_color[i] * diff * atten;
          specular += u_point_color[i] * spec * atten;
        }

        vec3 color = v_color * lighting + specular * u_specular;

        // Fog
        float fog = clamp((u_fog_range.y - v_dist) / (u_fog_range.y - u_fog_range.x), 0.0, 1.0);
        color = mix(u_fog_color, color, fog);

        gl_FragColor = vec4(color, u_alpha);
      }
    `;

    const program = ObsidGL.createProgram(gl, VS, FS);
    ObsidGL.useProgram(gl, program);
    const attr = ObsidGL.getAttribLocs(gl, program, ["a_pos", "a_norm", "a_color"]);
    const uni = ObsidGL.getUniformLocs(gl, program, [
      "u_vp", "u_model", "u_eye",
      "u_sun_color", "u_sun_dir", "u_ambient",
      "u_fog_color", "u_fog_range",
      "u_shininess", "u_specular", "u_alpha",
      "u_num_points",
    ]);
    // Array uniforms need per-element locations
    const uniPointPos = [], uniPointColor = [], uniPointRange = [];
    for (let i = 0; i < MAX_POINTS; i++) {
      uniPointPos.push(gl.getUniformLocation(program, `u_point_pos[${i}]`));
      uniPointColor.push(gl.getUniformLocation(program, `u_point_color[${i}]`));
      uniPointRange.push(gl.getUniformLocation(program, `u_point_range[${i}]`));
    }

    ObsidGL.enableDepthTest(gl);
    ObsidGL.enableCullFace(gl);

    // ── Mesh Storage ──────────────────────────────────
    const meshes = new Map();

    function newMesh() {
      return {
        pos: [0,0,0], rot: [0,0,0], scl: [1,1,1],
        visible: true,
        vbo: null, ibo: null, count: 0,
        shininess: 32, specular: [0,0,0], alpha: 1,
      };
    }

    function uploadMesh(id, vertPtr, vertCount, idxPtr, idxCount) {
      let m = meshes.get(id);
      if (!m) { m = newMesh(); meshes.set(id, m); }
      const verts = ObsidGL.viewF32(memory, vertPtr, vertCount * 9);
      const indices = ObsidGL.viewU16(memory, idxPtr, idxCount);
      if (!m.vbo) { m.vbo = ObsidGL.createBuffer(gl); m.ibo = ObsidGL.createBuffer(gl); }
      ObsidGL.uploadVertexBuffer(gl, m.vbo, verts);
      ObsidGL.uploadIndexBuffer(gl, m.ibo, indices);
      m.count = idxCount;
    }

    // ── Render State ──────────────────────────────────
    let cam = { fov:60, aspect:1, near:0.1, far:200, pos:[0,30,0], target:[0,0,0] };
    let sun = { color:[1,.95,.9], dir:[.5,1,.3] };
    let amb = [.15,.15,.2];
    let fog = { color:[.55,.65,.85], near:60, far:150 };
    const points = Array.from({length: MAX_POINTS}, () => ({
      pos: [0,0,0], color: [0,0,0], range: 0, active: false,
    }));

    function drawMesh(m) {
      const model = mat4ComposeTRS(m.pos, m.rot, m.scl);
      ObsidGL.uniformMatrix4fv(gl, uni.u_model, model);
      ObsidGL.uniform1f(gl, uni.u_shininess, m.shininess);
      ObsidGL.uniform3fv(gl, uni.u_specular, m.specular);
      ObsidGL.uniform1f(gl, uni.u_alpha, m.alpha);
      ObsidGL.bindVertexAttrib(gl, m.vbo, attr.a_pos, 3, 36, 0);
      ObsidGL.bindVertexAttrib(gl, m.vbo, attr.a_norm, 3, 36, 12);
      ObsidGL.bindVertexAttrib(gl, m.vbo, attr.a_color, 3, 36, 24);
      ObsidGL.drawElementsU16(gl, m.ibo, m.count);
    }

    function renderMeshes() {
      ObsidGL.clear(gl, fog.color[0], fog.color[1], fog.color[2]);
      const vp = mat4Mul(
        mat4Perspective(cam.fov, cam.aspect, cam.near, cam.far),
        mat4LookAt(cam.pos, cam.target, [0,1,0]),
      );
      ObsidGL.uniformMatrix4fv(gl, uni.u_vp, vp);
      ObsidGL.uniform3fv(gl, uni.u_eye, cam.pos);
      ObsidGL.uniform3fv(gl, uni.u_sun_color, sun.color);
      ObsidGL.uniform3fv(gl, uni.u_sun_dir, sun.dir);
      ObsidGL.uniform3fv(gl, uni.u_ambient, amb);
      ObsidGL.uniform3fv(gl, uni.u_fog_color, fog.color);
      ObsidGL.uniform2f(gl, uni.u_fog_range, fog.near, fog.far);

      // Upload point light uniforms
      let activeCount = 0;
      for (let i = 0; i < MAX_POINTS; i++) {
        if (points[i].active && points[i].range > 0) {
          ObsidGL.uniform3fv(gl, uniPointPos[activeCount], points[i].pos);
          ObsidGL.uniform3fv(gl, uniPointColor[activeCount], points[i].color);
          ObsidGL.uniform1f(gl, uniPointRange[activeCount], points[i].range);
          activeCount++;
        }
      }
      ObsidGL.uniform1i(gl, uni.u_num_points, activeCount);

      // Collect and sort
      const opaque = [], transparent = [];
      for (const [, m] of meshes) {
        if (!m.visible || !m.count) continue;
        (m.alpha < 1 ? transparent : opaque).push(m);
      }

      // Opaque pass
      ObsidGL.depthMask(gl, true);
      ObsidGL.disableBlend(gl);
      for (const m of opaque) drawMesh(m);

      // Transparent pass (back-to-front)
      if (transparent.length > 0) {
        transparent.sort((a, b) => {
          const da = (a.pos[0]-cam.pos[0])**2 + (a.pos[1]-cam.pos[1])**2 + (a.pos[2]-cam.pos[2])**2;
          const db = (b.pos[0]-cam.pos[0])**2 + (b.pos[1]-cam.pos[1])**2 + (b.pos[2]-cam.pos[2])**2;
          return db - da;
        });
        ObsidGL.enableBlend(gl);
        ObsidGL.depthMask(gl, false);
        for (const m of transparent) drawMesh(m);
        ObsidGL.depthMask(gl, true);
        ObsidGL.disableBlend(gl);
      }
    }

    // ── WASM Imports ──────────────────────────────────
    const imports = {
      obsid: {
        set_state(s,v){ state[N(s)]=N(v); },
        get_state(s){ return B(state[N(s)]??0); },
        set_state_f(s,v){ stateF[N(s)]=v; },
        get_state_f(s){ return stateF[N(s)]??0; },

        sin(x){return Math.sin(x);}, cos(x){return Math.cos(x);},
        sqrt(x){return Math.sqrt(x);}, abs(x){return Math.abs(x);},
        min(a,b){return Math.min(a,b);}, max(a,b){return Math.max(a,b);},
        floor(x){return Math.floor(x);}, ceil(x){return Math.ceil(x);},
        pow(x,y){return Math.pow(x,y);}, pi(){return Math.PI;},
        to_float(x){return N(x);},
        to_int(x){return B(Math.trunc(x));},

        get_aspect(){ return canvas.width/canvas.height; },

        // Mesh
        create_mesh(id){ meshes.set(N(id), newMesh()); },
        upload_mesh(id, vert_ptr, vert_count, idx_ptr, idx_count){
          uploadMesh(N(id), N(vert_ptr), N(vert_count), N(idx_ptr), N(idx_count));
        },
        set_mesh_position(id, x, y, z){
          const m = meshes.get(N(id)); if (m) m.pos = [x,y,z];
        },
        set_mesh_rotation(id, x, y, z){
          const m = meshes.get(N(id)); if (m) m.rot = [x,y,z];
        },
        set_mesh_scale(id, x, y, z){
          const m = meshes.get(N(id)); if (m) m.scl = [x,y,z];
        },
        set_mesh_material(id, shininess, sr, sg, sb){
          const m = meshes.get(N(id));
          if (m) { m.shininess = shininess; m.specular = [sr,sg,sb]; }
        },
        set_mesh_alpha(id, alpha){
          const m = meshes.get(N(id)); if (m) m.alpha = alpha;
        },
        set_mesh_visible(id, v){
          const m = meshes.get(N(id)); if (m) m.visible = N(v) !== 0;
        },
        delete_mesh(id){
          const m = meshes.get(N(id));
          if (m) {
            if (m.vbo) ObsidGL.deleteBuffer(gl, m.vbo);
            if (m.ibo) ObsidGL.deleteBuffer(gl, m.ibo);
            meshes.delete(N(id));
          }
        },

        // Camera & lighting
        set_camera(fov,aspect,near,far,px,py,pz,tx,ty,tz){
          cam={fov,aspect,near,far,pos:[px,py,pz],target:[tx,ty,tz]};
        },
        set_dir_light(r,g,b,dx,dy,dz){ sun={color:[r,g,b],dir:[dx,dy,dz]}; },
        set_ambient(r,g,b){ amb=[r,g,b]; },
        set_fog(r,g,b,near,far){ fog={color:[r,g,b],near,far}; },
        set_point_light(idx, x, y, z, r, g, b, range){
          const i = N(idx);
          if (i >= 0 && i < MAX_POINTS) {
            points[i] = { pos:[x,y,z], color:[r,g,b], range, active:true };
          }
        },
        clear_point_light(idx){
          const i = N(idx);
          if (i >= 0 && i < MAX_POINTS) points[i].active = false;
        },

        render(){ renderMeshes(); },
      },

      wasi_snapshot_preview1: {
        fd_write(fd,iovs,iovs_len,nwritten_ptr){
          const view=new DataView(memory.buffer);
          let written=0,output="";
          for(let i=0;i<iovs_len;i++){
            const ptr=view.getInt32(iovs+i*8,true);
            const len=view.getInt32(iovs+i*8+4,true);
            output+=new TextDecoder().decode(new Uint8Array(memory.buffer,ptr,len));
            written+=len;
          }
          if(fd===1)console.log(output.trimEnd());
          else if(fd===2)console.error(output.trimEnd());
          view.setInt32(nwritten_ptr,written,true);
          return 0;
        },
        clock_time_get(id,prec,ptr){
          new DataView(memory.buffer).setBigInt64(ptr,BigInt(Math.floor(performance.now()*1e6)),true);
          return 0;
        },
        proc_exit(c){if(c!==0)console.error(`exit(${c})`);},
        random_get(buf,len){crypto.getRandomValues(new Uint8Array(memory.buffer,buf,len));return 0;},
        path_open(){return 76;},fd_read(){return 76;},fd_close(){return 0;},
        fd_seek(){return 76;},fd_filestat_get(){return 76;},
        path_filestat_get(){return 76;},path_create_directory(){return 76;},
        path_rename(){return 76;},path_unlink_file(){return 76;},
        path_remove_directory(){return 76;},fd_prestat_get(){return 8;},
        fd_prestat_dir_name(){return 8;},fd_readdir(){return 76;},
      },
    };

    const {instance} = await WebAssembly.instantiate(await(await fetch(wasmUrl)).arrayBuffer(),imports);
    memory = instance.exports.memory;

    if (instance.exports._start) {
      try { instance.exports._start(); }
      catch(e) { console.error("_start:", e); }
    }

    if (instance.exports.render_frame) {
      let start = null;
      function animate(ts) {
        if (!start) start = ts;
        try { instance.exports.render_frame((ts-start)/1000); }
        catch(e) { console.warn("render_frame:",e.message); }
        requestAnimationFrame(animate);
      }
      requestAnimationFrame(animate);
    }

    return instance;
  },
};
