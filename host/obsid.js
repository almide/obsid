// obsid — generic mesh renderer for Almide
//
// WASM builds vertex/index data in linear memory using bytes.set_f32_le /
// bytes.set_u16_le and passes pointers via bytes.data_ptr. JS reads from
// memory.buffer with typed-array views (zero copy) and uploads to WebGL.
//
// Vertex format (36 bytes): pos[3] f32 + norm[3] f32 + color[3] f32
// Index format: u16
//
// Usage:
//   const instance = await Obsid.load("app.wasm", "canvas");

const Obsid = {
  async load(wasmUrl, canvasEl) {
    const canvas = typeof canvasEl === "string" ? document.getElementById(canvasEl) : canvasEl;
    if (!canvas) throw new Error(`Canvas not found: ${canvasEl}`);
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL not supported");

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

    // ── Mesh Storage ──────────────────────────────────
    const meshes = new Map();

    function uploadMesh(id, vertPtr, vertCount, idxPtr, idxCount) {
      let m = meshes.get(id);
      if (!m) { m = { pos:[0,0,0], visible:true, vbo:null, ibo:null, count:0 }; meshes.set(id, m); }
      // Zero-copy views into WASM linear memory
      const verts = new Float32Array(memory.buffer, vertPtr, vertCount * 9);
      const indices = new Uint16Array(memory.buffer, idxPtr, idxCount);
      if (!m.vbo) { m.vbo = gl.createBuffer(); m.ibo = gl.createBuffer(); }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      m.count = idxCount;
    }

    // ── Shader ────────────────────────────────────────
    const VS = `
      attribute vec3 a_pos, a_norm, a_color;
      uniform mat4 u_vp;
      uniform vec3 u_offset, u_eye;
      varying vec3 v_norm, v_color;
      varying float v_dist;
      void main() {
        vec3 wp = a_pos + u_offset;
        v_norm = a_norm;
        v_color = a_color;
        v_dist = length(wp - u_eye);
        gl_Position = u_vp * vec4(wp, 1.0);
      }
    `;
    const FS = `
      precision mediump float;
      varying vec3 v_norm, v_color;
      varying float v_dist;
      uniform vec3 u_sun_color, u_sun_dir, u_ambient, u_fog_color;
      uniform vec2 u_fog_range;
      void main() {
        float diff = max(dot(normalize(v_norm), normalize(u_sun_dir)), 0.0);
        vec3 c = v_color * (u_ambient + u_sun_color * diff);
        float fog = clamp((u_fog_range.y - v_dist) / (u_fog_range.y - u_fog_range.x), 0.0, 1.0);
        gl_FragColor = vec4(mix(u_fog_color, c, fog), 1.0);
      }
    `;

    let program, aPos, aNorm, aColor;
    let uVP, uOffset, uEye, uSunColor, uSunDir, uAmbient, uFogColor, uFogRange;

    function initShader() {
      const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs,VS); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs,gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vs));
      const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs,FS); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs,gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fs));
      program = gl.createProgram(); gl.attachShader(program,vs); gl.attachShader(program,fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const u = n => gl.getUniformLocation(program,n);
      uVP=u("u_vp"); uOffset=u("u_offset"); uEye=u("u_eye");
      uSunColor=u("u_sun_color"); uSunDir=u("u_sun_dir");
      uAmbient=u("u_ambient"); uFogColor=u("u_fog_color"); uFogRange=u("u_fog_range");
      aPos=gl.getAttribLocation(program,"a_pos");
      aNorm=gl.getAttribLocation(program,"a_norm");
      aColor=gl.getAttribLocation(program,"a_color");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aNorm);
      gl.enableVertexAttribArray(aColor);
      gl.enable(gl.DEPTH_TEST);
    }

    // ── Render State ──────────────────────────────────
    let cam = { fov:60, aspect:1, near:0.1, far:200, pos:[0,30,0], target:[0,0,0] };
    let sun = { color:[1,.95,.9], dir:[.5,1,.3] };
    let amb = [.15,.15,.2];
    let fog = { color:[.55,.65,.85], near:60, far:150 };

    function renderMeshes() {
      gl.clearColor(fog.color[0],fog.color[1],fog.color[2],1);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      const vp = mat4Mul(mat4Perspective(cam.fov,cam.aspect,cam.near,cam.far),
                         mat4LookAt(cam.pos,cam.target,[0,1,0]));
      gl.uniformMatrix4fv(uVP,false,vp);
      gl.uniform3fv(uEye,cam.pos);
      gl.uniform3fv(uSunColor,sun.color);
      gl.uniform3fv(uSunDir,sun.dir);
      gl.uniform3fv(uAmbient,amb);
      gl.uniform3fv(uFogColor,fog.color);
      gl.uniform2f(uFogRange,fog.near,fog.far);
      for (const [,m] of meshes) {
        if (!m.visible || !m.count) continue;
        gl.uniform3fv(uOffset,m.pos);
        gl.bindBuffer(gl.ARRAY_BUFFER,m.vbo);
        gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,36,0);
        gl.vertexAttribPointer(aNorm,3,gl.FLOAT,false,36,12);
        gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,36,24);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.ibo);
        gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_SHORT,0);
      }
    }

    // ── WASM Imports ──────────────────────────────────
    const imports = {
      obsid: {
        // State
        set_state(s,v){ state[N(s)]=N(v); },
        get_state(s){ return B(state[N(s)]??0); },
        set_state_f(s,v){ stateF[N(s)]=v; },
        get_state_f(s){ return stateF[N(s)]??0; },

        // Math
        sin(x){return Math.sin(x);}, cos(x){return Math.cos(x);},
        sqrt(x){return Math.sqrt(x);}, abs(x){return Math.abs(x);},
        min(a,b){return Math.min(a,b);}, max(a,b){return Math.max(a,b);},
        floor(x){return Math.floor(x);}, ceil(x){return Math.ceil(x);},
        pow(x,y){return Math.pow(x,y);}, pi(){return Math.PI;},
        to_float(x){return N(x);},
        to_int(x){return B(Math.trunc(x));},

        // Canvas
        get_aspect(){ return canvas.width/canvas.height; },

        // Mesh
        create_mesh(id){
          meshes.set(N(id), { pos:[0,0,0], visible:true, vbo:null, ibo:null, count:0 });
        },
        upload_mesh(id, vert_ptr, vert_count, idx_ptr, idx_count){
          uploadMesh(N(id), N(vert_ptr), N(vert_count), N(idx_ptr), N(idx_count));
        },
        set_mesh_position(id, x, y, z){
          const m = meshes.get(N(id)); if (m) m.pos = [x,y,z];
        },
        set_mesh_visible(id, v){
          const m = meshes.get(N(id)); if (m) m.visible = N(v) !== 0;
        },
        delete_mesh(id){
          const m = meshes.get(N(id));
          if (m) {
            if (m.vbo) gl.deleteBuffer(m.vbo);
            if (m.ibo) gl.deleteBuffer(m.ibo);
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

        // Render
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
    initShader();

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
