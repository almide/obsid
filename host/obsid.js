// obsid v2 — voxel chunk renderer for Almide
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

    // ── Block Palette ─────────────────────────────────
    //          top color          side color         bottom color
    const PAL = [
      null,
      [[.36,.74,.22], [.44,.32,.18], [.44,.30,.16]],  // 1 grass
      [[.48,.47,.46], [.42,.41,.40], [.38,.37,.36]],  // 2 stone
      [[.52,.34,.20], [.46,.30,.18], [.42,.28,.16]],  // 3 dirt
      [[.85,.80,.55], [.78,.72,.48], [.72,.66,.42]],  // 4 sand
      [[.40,.28,.14], [.34,.22,.10], [.30,.20,.08]],  // 5 wood
      [[.20,.52,.14], [.18,.44,.12], [.16,.38,.10]],  // 6 leaves
      [[.90,.92,.95], [.82,.84,.88], [.76,.78,.82]],  // 7 snow
      [[.20,.42,.72], [.18,.38,.66], [.16,.34,.60]],  // 8 water
    ];

    // ── Face Geometry ─────────────────────────────────
    // face: 0=+Y 1=-Y 2=+Z 3=-Z 4=+X 5=-X
    const FV = [
      [[0,1,0],[1,1,0],[1,1,1],[0,1,1]],
      [[0,0,1],[1,0,1],[1,0,0],[0,0,0]],
      [[1,0,1],[0,0,1],[0,1,1],[1,1,1]],
      [[0,0,0],[1,0,0],[1,1,0],[0,1,0]],
      [[1,0,0],[1,0,1],[1,1,1],[1,1,0]],
      [[0,0,1],[0,0,0],[0,1,0],[0,1,1]],
    ];
    const FN = [[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,0,0],[-1,0,0]];
    const FD = [[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,0,0],[-1,0,0]];
    const FAO = [1.0, 0.5, 0.8, 0.65, 0.85, 0.7]; // per-face AO

    // ── Chunk Meshing ─────────────────────────────────
    const chunks = new Map();

    function meshChunk(chunk) {
      const B = chunk.blocks;
      const verts = [], idx = [];
      let vi = 0;
      for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const bt = B[x + z*16 + y*256];
        if (!bt) continue;
        const pal = PAL[bt];
        if (!pal) continue;
        const noise = (((x*73856093)^(y*19349663)^(z*83492791)) >>> 0 & 0xff) / 255 * 0.06 - 0.03;
        for (let f = 0; f < 6; f++) {
          const [dx,dy,dz] = FD[f];
          const nx=x+dx, ny=y+dy, nz=z+dz;
          if (nx>=0&&nx<16&&ny>=0&&ny<16&&nz>=0&&nz<16 && B[nx+nz*16+ny*256]) continue;
          const col = pal[f<2?f:2];
          const ao = FAO[f];
          const [fnx,fny,fnz] = FN[f];
          const cr = Math.max(0, (col[0]+noise)*ao);
          const cg = Math.max(0, (col[1]+noise)*ao);
          const cb = Math.max(0, (col[2]+noise)*ao);
          for (const [vx,vy,vz] of FV[f])
            verts.push(x+vx, y+vy, z+vz, fnx, fny, fnz, cr, cg, cb);
          idx.push(vi,vi+1,vi+2, vi,vi+2,vi+3);
          vi += 4;
        }
      }
      if (!vi) { chunk.count = 0; return; }
      if (!chunk.vbo) { chunk.vbo = gl.createBuffer(); chunk.ibo = gl.createBuffer(); }
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
      chunk.count = idx.length;
    }

    // ── Shader ────────────────────────────────────────
    const VS = `
      attribute vec3 a_pos, a_norm, a_color;
      uniform mat4 u_vp;
      uniform vec3 u_chunk, u_eye;
      varying vec3 v_norm, v_color, v_wpos;
      varying float v_dist;
      void main() {
        vec3 wp = a_pos + u_chunk;
        v_wpos = wp;
        v_norm = a_norm;
        v_color = a_color;
        v_dist = length(wp - u_eye);
        gl_Position = u_vp * vec4(wp, 1.0);
      }
    `;
    const FS = `
      precision mediump float;
      varying vec3 v_norm, v_color, v_wpos;
      varying float v_dist;
      uniform vec3 u_sun_color, u_sun_dir, u_ambient, u_fog_color;
      uniform vec2 u_fog_range;
      void main() {
        float diff = max(dot(normalize(v_norm), normalize(u_sun_dir)), 0.0);
        vec3 c = v_color * (u_ambient + u_sun_color * diff);

        // Block grid lines
        vec3 f = fract(v_wpos + 0.001);
        vec3 d = min(f, 1.0 - f);
        vec3 an = abs(v_norm);
        float d1, d2;
        if (an.x > 0.5) { d1 = d.y; d2 = d.z; }
        else if (an.y > 0.5) { d1 = d.x; d2 = d.z; }
        else { d1 = d.x; d2 = d.y; }
        float line = min(smoothstep(0.0, 0.06, d1), smoothstep(0.0, 0.06, d2));
        c *= mix(0.6, 1.0, line);

        float fog = clamp((u_fog_range.y - v_dist) / (u_fog_range.y - u_fog_range.x), 0.0, 1.0);
        gl_FragColor = vec4(mix(u_fog_color, c, fog), 1.0);
      }
    `;

    let program, aPos, aNorm, aColor;
    let uVP, uChunk, uEye, uSunColor, uSunDir, uAmbient, uFogColor, uFogRange;

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
      uVP=u("u_vp"); uChunk=u("u_chunk"); uEye=u("u_eye");
      uSunColor=u("u_sun_color"); uSunDir=u("u_sun_dir");
      uAmbient=u("u_ambient"); uFogColor=u("u_fog_color"); uFogRange=u("u_fog_range");
      aPos=gl.getAttribLocation(program,"a_pos");
      aNorm=gl.getAttribLocation(program,"a_norm");
      aColor=gl.getAttribLocation(program,"a_color");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aNorm);
      gl.enableVertexAttribArray(aColor);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
    }

    // ── Render ────────────────────────────────────────
    let cam = { fov:60, aspect:1, near:0.1, far:200, pos:[0,30,0], target:[32,0,32] };
    let sun = { color:[1,.95,.9], dir:[.5,1,.3] };
    let amb = [.15,.15,.2];
    let fog = { color:[.55,.65,.85], near:60, far:150 };

    function renderChunks() {
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
      for (const [,ch] of chunks) {
        if (!ch.visible||!ch.count) continue;
        gl.uniform3fv(uChunk,ch.wp);
        gl.bindBuffer(gl.ARRAY_BUFFER,ch.vbo);
        gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,36,0);
        gl.vertexAttribPointer(aNorm,3,gl.FLOAT,false,36,12);
        gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,36,24);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ch.ibo);
        gl.drawElements(gl.TRIANGLES,ch.count,gl.UNSIGNED_SHORT,0);
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

        create_chunk(id){
          chunks.set(N(id),{blocks:new Uint8Array(4096),wp:[0,0,0],visible:true,vbo:null,ibo:null,count:0});
        },
        set_block(cid,x,y,z,bt){
          const c=chunks.get(N(cid));
          if(c) c.blocks[N(x)+N(z)*16+N(y)*256]=N(bt);
        },
        build_chunk(cid,wx,wy,wz){
          const c=chunks.get(N(cid));
          if(c){c.wp=[wx,wy,wz];meshChunk(c);}
        },
        remove_chunk(cid){ chunks.delete(N(cid)); },
        set_chunk_visible(cid,v){
          const c=chunks.get(N(cid)); if(c) c.visible=N(v)!==0;
        },

        set_camera(fov,aspect,near,far,px,py,pz,tx,ty,tz){
          cam={fov,aspect,near,far,pos:[px,py,pz],target:[tx,ty,tz]};
        },
        set_dir_light(r,g,b,dx,dy,dz){ sun={color:[r,g,b],dir:[dx,dy,dz]}; },
        set_ambient(r,g,b){ amb=[r,g,b]; },
        set_fog(r,g,b,near,far){ fog={color:[r,g,b],near,far}; },

        render(){ renderChunks(); },
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
