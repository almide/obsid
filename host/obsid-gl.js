// obsid-gl — thin WebGL WASM bridge
//
// Low-level primitives for WASM-driven WebGL rendering:
// - Shader program compilation
// - Buffer creation / data upload (from typed array views over WASM memory)
// - Vertex attribute binding
// - Uniform setters
// - Draw calls
// - Render state (depth, culling, blending, viewport)
//
// obsid.js builds the 3D rendering foundation on top of this.
// Future: expose WASM imports so Almide code can drive obsid-gl directly.

const ObsidGL = {
  // ── Initialization ────────────────────────────────
  init(canvasEl, opts = {}) {
    const canvas = typeof canvasEl === "string" ? document.getElementById(canvasEl) : canvasEl;
    if (!canvas) throw new Error(`Canvas not found: ${canvasEl}`);
    // Try WebGL 2 first, fall back to WebGL 1. iOS Safari sometimes has
    // quirks with WebGL 2; the WebGL 1 path is more battle-tested.
    const contextOpts = {
      antialias: opts.antialias !== false,
      preserveDrawingBuffer: false,
      // Opaque fullscreen canvas — skip the alpha channel so the browser
      // compositor doesn't have to blend us with the page underneath.
      alpha: false,
      // Ask the browser to prefer the discrete / fast GPU where available.
      powerPreference: "high-performance",
    };
    let gl = canvas.getContext("webgl2", contextOpts)
          || canvas.getContext("webgl", contextOpts)
          || canvas.getContext("experimental-webgl", contextOpts);
    if (!gl) throw new Error("WebGL not supported on this device");
    return { gl, canvas };
  },

  // ── Shader program ────────────────────────────────
  compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const kind = type === gl.VERTEX_SHADER ? "VS" : "FS";
      console.error(kind + " compile:", log);
      if (typeof Obsid !== "undefined") Obsid.showError(kind + " compile:\n" + log);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  },

  createProgram(gl, vsSrc, fsSrc) {
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      console.error("program link:", log);
      if (typeof Obsid !== "undefined") Obsid.showError("program link:\n" + log);
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  },

  getAttribLocs(gl, program, names) {
    const locs = {};
    for (const n of names) locs[n] = gl.getAttribLocation(program, n);
    return locs;
  },

  getUniformLocs(gl, program, names) {
    const locs = {};
    for (const n of names) locs[n] = gl.getUniformLocation(program, n);
    return locs;
  },

  // ── Buffers (zero-copy upload from WASM memory) ───
  createBuffer(gl) {
    return gl.createBuffer();
  },

  deleteBuffer(gl, buf) {
    gl.deleteBuffer(buf);
  },

  uploadVertexBuffer(gl, buf, typedArray, usage) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, typedArray, usage || gl.STATIC_DRAW);
  },

  uploadIndexBuffer(gl, buf, typedArray, usage) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, typedArray, usage || gl.STATIC_DRAW);
  },

  // Create a Float32Array view over WASM memory without copying.
  viewF32(memory, byteOffset, floatCount) {
    return new Float32Array(memory.buffer, byteOffset, floatCount);
  },

  viewU16(memory, byteOffset, count) {
    return new Uint16Array(memory.buffer, byteOffset, count);
  },

  viewU8(memory, byteOffset, count) {
    return new Uint8Array(memory.buffer, byteOffset, count);
  },

  // ── Textures ──────────────────────────────────────
  createTexture(gl, pixels, width, height, opts = {}) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const isPOT = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;

    // Mipmap chain for minification — only meaningful on power-of-two
    // textures in WebGL 1. Pairs with LINEAR_MIPMAP_LINEAR (trilinear) for
    // smooth texture minification at distance and oblique angles.
    if (opts.mipmap && isPOT) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }

    // Anisotropic filtering — keeps the checker pattern crisp when the
    // surface is viewed at a grazing angle. It's an extension in both
    // WebGL 1 and WebGL 2, and the common browsers still publish it under
    // the EXT prefix (WebKit/MOZ variants covered for older engines).
    const anisoRequested = opts.aniso || 1;
    if (anisoRequested > 1) {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic")
               || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic")
               || gl.getExtension("MOZ_EXT_texture_filter_anisotropic");
      if (ext) {
        const maxSupported = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisoRequested, maxSupported));
      }
    }

    const wrap = isPOT ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  },

  deleteTexture(gl, tex) {
    gl.deleteTexture(tex);
  },

  bindTextureUnit(gl, unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  },

  // ── Vertex attributes ─────────────────────────────
  bindVertexAttrib(gl, buf, loc, size, stride, offset) {
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.enableVertexAttribArray(loc);
  },

  // ── Uniforms ──────────────────────────────────────
  uniform1i(gl, loc, v) { if (loc) gl.uniform1i(loc, v); },
  uniform1f(gl, loc, v) { if (loc) gl.uniform1f(loc, v); },
  uniform2f(gl, loc, x, y) { if (loc) gl.uniform2f(loc, x, y); },
  uniform3fv(gl, loc, v) { if (loc) gl.uniform3fv(loc, v); },
  uniformMatrix4fv(gl, loc, v) { if (loc) gl.uniformMatrix4fv(loc, false, v); },

  // ── State ─────────────────────────────────────────
  clear(gl, r, g, b, a) {
    gl.clearColor(r, g, b, a ?? 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  },

  enableDepthTest(gl) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  },

  enableCullFace(gl) {
    gl.enable(gl.CULL_FACE);
  },

  disableCullFace(gl) {
    gl.disable(gl.CULL_FACE);
  },

  viewport(gl, x, y, w, h) {
    gl.viewport(x, y, w, h);
  },

  depthMask(gl, enabled) {
    gl.depthMask(enabled);
  },

  enableBlend(gl) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  },

  disableBlend(gl) {
    gl.disable(gl.BLEND);
  },

  // ── Draw ──────────────────────────────────────────
  drawElementsU16(gl, indexBuf, count) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  },

  useProgram(gl, program) {
    gl.useProgram(program);
  },
};

if (typeof window !== "undefined") window.ObsidGL = ObsidGL;
