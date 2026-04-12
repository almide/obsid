// almide/canvas — JS host implementation for WASM Canvas 2D API
//
// Usage:
//   const instance = await AlmideCanvas.load("app.wasm", "canvas");
//
// The WASM module must export "memory" and "_start".

const AlmideCanvas = {
  /**
   * Load an Almide WASM module with Canvas 2D bindings.
   * @param {string} wasmUrl - URL to the .wasm file
   * @param {string|HTMLCanvasElement} canvasEl - Canvas element or its ID
   * @returns {Promise<WebAssembly.Instance>}
   */
  async load(wasmUrl, canvasEl) {
    const canvas = typeof canvasEl === "string"
      ? document.getElementById(canvasEl)
      : canvasEl;
    if (!canvas) throw new Error(`Canvas not found: ${canvasEl}`);
    const ctx = canvas.getContext("2d");

    let memory;

    function readString(ptr) {
      const view = new DataView(memory.buffer);
      const len = view.getInt32(ptr, true);
      const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
      return new TextDecoder().decode(bytes);
    }

    const imports = {
      canvas: {
        // Canvas control
        set_size(w, h) { canvas.width = w; canvas.height = h; },

        // Rectangles
        fill_rect(x, y, w, h) { ctx.fillRect(x, y, w, h); },
        stroke_rect(x, y, w, h) { ctx.strokeRect(x, y, w, h); },
        clear_rect(x, y, w, h) { ctx.clearRect(x, y, w, h); },

        // Styles
        set_fill_style(ptr) { ctx.fillStyle = readString(ptr); },
        set_stroke_style(ptr) { ctx.strokeStyle = readString(ptr); },
        set_line_width(w) { ctx.lineWidth = w; },
        set_line_cap(ptr) { ctx.lineCap = readString(ptr); },
        set_line_join(ptr) { ctx.lineJoin = readString(ptr); },
        set_global_alpha(a) { ctx.globalAlpha = a; },
        set_shadow_color(ptr) { ctx.shadowColor = readString(ptr); },
        set_shadow_blur(b) { ctx.shadowBlur = b; },
        set_shadow_offset(x, y) { ctx.shadowOffsetX = x; ctx.shadowOffsetY = y; },

        // Paths
        begin_path() { ctx.beginPath(); },
        close_path() { ctx.closePath(); },
        move_to(x, y) { ctx.moveTo(x, y); },
        line_to(x, y) { ctx.lineTo(x, y); },
        arc(cx, cy, r, start, end) { ctx.arc(cx, cy, r, start, end); },
        arc_to(x1, y1, x2, y2, r) { ctx.arcTo(x1, y1, x2, y2, r); },
        bezier_curve_to(cp1x, cp1y, cp2x, cp2y, x, y) { ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y); },
        quadratic_curve_to(cpx, cpy, x, y) { ctx.quadraticCurveTo(cpx, cpy, x, y); },
        rect(x, y, w, h) { ctx.rect(x, y, w, h); },
        fill() { ctx.fill(); },
        stroke() { ctx.stroke(); },
        clip() { ctx.clip(); },

        // Text
        set_font(ptr) { ctx.font = readString(ptr); },
        set_text_align(ptr) { ctx.textAlign = readString(ptr); },
        set_text_baseline(ptr) { ctx.textBaseline = readString(ptr); },
        fill_text(ptr, x, y) { ctx.fillText(readString(ptr), x, y); },
        stroke_text(ptr, x, y) { ctx.strokeText(readString(ptr), x, y); },

        // Transforms
        save() { ctx.save(); },
        restore() { ctx.restore(); },
        translate(x, y) { ctx.translate(x, y); },
        rotate(angle) { ctx.rotate(angle); },
        scale(x, y) { ctx.scale(x, y); },
        reset_transform() { ctx.resetTransform(); },
      },

      // Minimal WASI shim (for println → console.log)
      wasi_snapshot_preview1: {
        fd_write(fd, iovs, iovs_len, nwritten_ptr) {
          const view = new DataView(memory.buffer);
          let written = 0;
          let output = "";
          for (let i = 0; i < iovs_len; i++) {
            const ptr = view.getInt32(iovs + i * 8, true);
            const len = view.getInt32(iovs + i * 8 + 4, true);
            const bytes = new Uint8Array(memory.buffer, ptr, len);
            output += new TextDecoder().decode(bytes);
            written += len;
          }
          if (fd === 1) console.log(output.trimEnd());
          else if (fd === 2) console.error(output.trimEnd());
          view.setInt32(nwritten_ptr, written, true);
          return 0;
        },
        clock_time_get(id, precision, time_ptr) {
          const view = new DataView(memory.buffer);
          const now = BigInt(Math.floor(performance.now() * 1e6));
          view.setBigInt64(time_ptr, now, true);
          return 0;
        },
        proc_exit(code) { if (code !== 0) console.error(`exit(${code})`); },
        random_get(buf, len) {
          const bytes = new Uint8Array(memory.buffer, buf, len);
          crypto.getRandomValues(bytes);
          return 0;
        },
        // File I/O stubs (not available in browser)
        path_open() { return 76; },  // ENOTSUP
        fd_read() { return 76; },
        fd_close() { return 0; },
        fd_seek() { return 76; },
        fd_filestat_get() { return 76; },
        path_filestat_get() { return 76; },
        path_create_directory() { return 76; },
        path_rename() { return 76; },
        path_unlink_file() { return 76; },
        path_remove_directory() { return 76; },
        fd_prestat_get() { return 8; },  // EBADF — stops preopen scan
        fd_prestat_dir_name() { return 8; },
        fd_readdir() { return 76; },
      },
    };

    const response = await fetch(wasmUrl);
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    memory = instance.exports.memory;

    // Run _start (Almide entry point)
    if (instance.exports._start) {
      instance.exports._start();
    }

    return instance;
  },
};
