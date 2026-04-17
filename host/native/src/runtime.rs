//! `obsid.*` wasm import implementation, generic over the host's store data type.
//!
//! Callers provide an accessor `fn(&mut T) -> &mut RenderState` so their own
//! store data can bundle additional state (WASI ctx, audio state, http state, …)
//! alongside obsid's renderer state.

use std::collections::HashMap;

use anyhow::Result;
use wasmtime::{Caller, Linker, Memory};

use crate::gpu::{
    mat4_compose_trs, mat4_look_at, mat4_mul, mat4_perspective, Gpu, Mesh, Uniforms, MAX_POINTS,
    VERTEX_STRIDE,
};

/// Renderer-side slice of a host's wasmtime store data.
///
/// Almide's `Float` is WASM `f64` and `Int` is WASM `i64`; all `@extern`
/// signatures under the `obsid` namespace follow that. Values are cast to f32
/// at the GPU boundary.
pub struct RenderState {
    pub gpu: Gpu,
    pub memory: Option<Memory>,

    pub meshes: HashMap<i32, Mesh>,
    pub state_i: HashMap<i32, i64>,
    pub state_f: HashMap<i32, f32>,

    pub cam_fov: f32,
    pub cam_aspect: f32,
    pub cam_near: f32,
    pub cam_far: f32,
    pub cam_pos: [f32; 3],
    pub cam_target: [f32; 3],

    pub sun_color: [f32; 3],
    pub sun_dir: [f32; 3],
    pub ambient: [f32; 3],
    pub fog_color: [f32; 3],
    pub fog_near: f32,
    pub fog_far: f32,
    pub point_pos: [[f32; 3]; MAX_POINTS],
    pub point_color: [[f32; 3]; MAX_POINTS],
    pub point_range: [f32; MAX_POINTS],
    pub point_active: [bool; MAX_POINTS],

    pub current_view: Option<wgpu::TextureView>,
}

impl RenderState {
    pub fn new(gpu: Gpu) -> Self {
        Self {
            gpu,
            memory: None,
            meshes: HashMap::new(),
            state_i: HashMap::new(),
            state_f: HashMap::new(),
            cam_fov: 60.0,
            cam_aspect: 1.0,
            cam_near: 0.1,
            cam_far: 200.0,
            cam_pos: [0.0, 30.0, 0.0],
            cam_target: [0.0, 0.0, 0.0],
            sun_color: [1.0, 0.95, 0.9],
            sun_dir: [0.5, 1.0, 0.3],
            ambient: [0.15, 0.15, 0.2],
            fog_color: [0.55, 0.65, 0.85],
            fog_near: 60.0,
            fog_far: 150.0,
            point_pos: [[0.0; 3]; MAX_POINTS],
            point_color: [[0.0; 3]; MAX_POINTS],
            point_range: [0.0; MAX_POINTS],
            point_active: [false; MAX_POINTS],
            current_view: None,
        }
    }

    pub fn aspect(&self) -> f32 {
        self.gpu.surface_config.width as f32 / self.gpu.surface_config.height.max(1) as f32
    }

    fn render_frame_internal(&mut self) {
        let Some(view) = self.current_view.as_ref() else {
            return;
        };

        let vp = mat4_mul(
            mat4_perspective(self.cam_fov, self.cam_aspect, self.cam_near, self.cam_far),
            mat4_look_at(self.cam_pos, self.cam_target, [0.0, 1.0, 0.0]),
        );

        let (mut point_pos_padded, mut point_color_padded, mut active_count) =
            ([[0.0f32; 4]; MAX_POINTS], [[0.0f32; 4]; MAX_POINTS], 0i32);
        for i in 0..MAX_POINTS {
            if self.point_active[i] && self.point_range[i] > 0.0 {
                let k = active_count as usize;
                point_pos_padded[k] = [
                    self.point_pos[i][0],
                    self.point_pos[i][1],
                    self.point_pos[i][2],
                    self.point_range[i],
                ];
                point_color_padded[k] = [
                    self.point_color[i][0],
                    self.point_color[i][1],
                    self.point_color[i][2],
                    0.0,
                ];
                active_count += 1;
            }
        }

        let mut draw_list: Vec<i32> = self
            .meshes
            .iter()
            .filter(|(_, m)| m.visible && m.index_count > 0)
            .map(|(id, _)| *id)
            .collect();
        draw_list.sort_by(|a, b| {
            let ma = &self.meshes[a];
            let mb = &self.meshes[b];
            let a_trans = ma.alpha < 1.0;
            let b_trans = mb.alpha < 1.0;
            if a_trans != b_trans {
                return a_trans.cmp(&b_trans);
            }
            if a_trans && b_trans {
                let cam = self.cam_pos;
                let da = dist2(ma.pos, cam);
                let db = dist2(mb.pos, cam);
                return db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal);
            }
            std::cmp::Ordering::Equal
        });

        let mut first = true;
        for id in draw_list {
            let mesh = match self.meshes.get(&id) {
                Some(m) => m,
                None => continue,
            };

            let model = mat4_compose_trs(mesh.pos, mesh.rot, mesh.scl);
            let uniforms = Uniforms {
                vp,
                model,
                eye: [self.cam_pos[0], self.cam_pos[1], self.cam_pos[2], 0.0],
                sun_color: [self.sun_color[0], self.sun_color[1], self.sun_color[2], 0.0],
                sun_dir: [self.sun_dir[0], self.sun_dir[1], self.sun_dir[2], 0.0],
                ambient: [self.ambient[0], self.ambient[1], self.ambient[2], 0.0],
                fog_color: [self.fog_color[0], self.fog_color[1], self.fog_color[2], 0.0],
                fog_range: [self.fog_near, self.fog_far, mesh.shininess, mesh.alpha],
                specular: [mesh.specular[0], mesh.specular[1], mesh.specular[2], 0.0],
                point_pos: point_pos_padded,
                point_color: point_color_padded,
                num_points: [active_count, 0, 0, 0],
            };
            self.gpu
                .queue
                .write_buffer(&self.gpu.uniforms_buffer, 0, bytemuck::bytes_of(&uniforms));

            let mut encoder =
                self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("obsid frame"),
                });
            let color_op = if first {
                wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: self.fog_color[0] as f64,
                        g: self.fog_color[1] as f64,
                        b: self.fog_color[2] as f64,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                }
            } else {
                wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }
            };
            let depth_op = if first {
                wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }
            } else {
                wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }
            };
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("obsid pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view,
                        resolve_target: None,
                        ops: color_op,
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &self.gpu.depth_view,
                        depth_ops: Some(depth_op),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(&self.gpu.pipeline);
                pass.set_bind_group(0, &self.gpu.bind_group, &[]);
                pass.set_vertex_buffer(0, mesh.vb.slice(..));
                pass.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint16);
                pass.draw_indexed(0..mesh.index_count, 0, 0..1);
            }
            self.gpu.queue.submit(Some(encoder.finish()));
            first = false;
        }

        if first {
            let mut encoder =
                self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("obsid clear"),
                });
            {
                let _ = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("obsid clear pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: self.fog_color[0] as f64,
                                g: self.fog_color[1] as f64,
                                b: self.fog_color[2] as f64,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &self.gpu.depth_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
            }
            self.gpu.queue.submit(Some(encoder.finish()));
        }
    }
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    dx * dx + dy * dy + dz * dz
}

/// Wire every `obsid.*` import into `linker`. The `accessor` extracts the
/// [`RenderState`] slice from the host's store data so callers can compose
/// additional import namespaces (wasi, audio, http, …) on the same store.
pub fn register_obsid_imports<T: 'static>(
    linker: &mut Linker<T>,
    accessor: fn(&mut T) -> &mut RenderState,
) -> Result<()> {
    // ── Math ──
    linker.func_wrap("obsid", "sin", |x: f64| x.sin())?;
    linker.func_wrap("obsid", "cos", |x: f64| x.cos())?;
    linker.func_wrap("obsid", "sqrt", |x: f64| x.sqrt())?;
    linker.func_wrap("obsid", "abs", |x: f64| x.abs())?;
    linker.func_wrap("obsid", "min", |a: f64, b: f64| a.min(b))?;
    linker.func_wrap("obsid", "max", |a: f64, b: f64| a.max(b))?;
    linker.func_wrap("obsid", "floor", |x: f64| x.floor())?;
    linker.func_wrap("obsid", "pi", || std::f64::consts::PI)?;
    linker.func_wrap("obsid", "pow", |x: f64, y: f64| x.powf(y))?;
    linker.func_wrap("obsid", "to_float", |x: i64| x as f64)?;
    linker.func_wrap("obsid", "to_int", |x: f64| x.trunc() as i64)?;

    // ── State ──
    linker.func_wrap(
        "obsid",
        "set_state",
        move |mut caller: Caller<'_, T>, slot: i64, value: i64| {
            accessor(caller.data_mut()).state_i.insert(slot as i32, value);
        },
    )?;
    linker.func_wrap(
        "obsid",
        "get_state",
        move |mut caller: Caller<'_, T>, slot: i64| -> i64 {
            *accessor(caller.data_mut())
                .state_i
                .get(&(slot as i32))
                .unwrap_or(&0)
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_state_f",
        move |mut caller: Caller<'_, T>, slot: i64, value: f64| {
            accessor(caller.data_mut())
                .state_f
                .insert(slot as i32, value as f32);
        },
    )?;
    linker.func_wrap(
        "obsid",
        "get_state_f",
        move |mut caller: Caller<'_, T>, slot: i64| -> f64 {
            *accessor(caller.data_mut())
                .state_f
                .get(&(slot as i32))
                .unwrap_or(&0.0) as f64
        },
    )?;

    // ── Mesh ──
    linker.func_wrap(
        "obsid",
        "create_mesh",
        |_caller: Caller<'_, T>, _id: i64| {
            // Lazily created in upload_mesh once we know the buffer sizes.
        },
    )?;
    linker.func_wrap(
        "obsid",
        "upload_mesh",
        move |mut caller: Caller<'_, T>,
              id: i64,
              vert_ptr: i64,
              vert_count: i64,
              idx_ptr: i64,
              idx_count: i64|
              -> anyhow::Result<()> {
            let memory = accessor(caller.data_mut())
                .memory
                .ok_or_else(|| anyhow::anyhow!("memory not ready"))?;
            let vert_bytes = (vert_count as usize) * VERTEX_STRIDE as usize;
            let idx_bytes = (idx_count as usize) * 2;
            let (verts, indices) = {
                let data = memory.data(&caller);
                let v_start = vert_ptr as usize;
                let i_start = idx_ptr as usize;
                let verts = data[v_start..v_start + vert_bytes].to_vec();
                let indices = data[i_start..i_start + idx_bytes].to_vec();
                (verts, indices)
            };
            let state = accessor(caller.data_mut());
            let vb = state
                .gpu
                .create_buffer(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, &verts);
            let ib = state
                .gpu
                .create_buffer(wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST, &indices);
            state
                .meshes
                .insert(id as i32, Mesh::new(vb, ib, idx_count as u32));
            Ok(())
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_position",
        move |mut caller: Caller<'_, T>, id: i64, x: f64, y: f64, z: f64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.pos = [x as f32, y as f32, z as f32];
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_rotation",
        move |mut caller: Caller<'_, T>, id: i64, x: f64, y: f64, z: f64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.rot = [x as f32, y as f32, z as f32];
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_scale",
        move |mut caller: Caller<'_, T>, id: i64, x: f64, y: f64, z: f64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.scl = [x as f32, y as f32, z as f32];
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_material",
        move |mut caller: Caller<'_, T>,
              id: i64,
              shininess: f64,
              sr: f64,
              sg: f64,
              sb: f64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.shininess = shininess as f32;
                m.specular = [sr as f32, sg as f32, sb as f32];
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_alpha",
        move |mut caller: Caller<'_, T>, id: i64, alpha: f64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.alpha = alpha as f32;
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_visible",
        move |mut caller: Caller<'_, T>, id: i64, visible: i64| {
            if let Some(m) = accessor(caller.data_mut()).meshes.get_mut(&(id as i32)) {
                m.visible = visible != 0;
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "delete_mesh",
        move |mut caller: Caller<'_, T>, id: i64| {
            accessor(caller.data_mut()).meshes.remove(&(id as i32));
        },
    )?;

    // ── Textures (stubs — Phase 2) ──
    linker.func_wrap(
        "obsid",
        "upload_texture",
        |_caller: Caller<'_, T>, _id: i64, _ptr: i64, _w: i64, _h: i64| {},
    )?;
    linker.func_wrap(
        "obsid",
        "set_mesh_texture",
        |_caller: Caller<'_, T>, _mid: i64, _tid: i64| {},
    )?;
    linker.func_wrap(
        "obsid",
        "clear_mesh_texture",
        |_caller: Caller<'_, T>, _mid: i64| {},
    )?;
    linker.func_wrap(
        "obsid",
        "delete_texture",
        |_caller: Caller<'_, T>, _id: i64| {},
    )?;

    // ── Camera & lighting ──
    linker.func_wrap(
        "obsid",
        "set_camera",
        move |mut caller: Caller<'_, T>,
              fov: f64,
              aspect: f64,
              near: f64,
              far: f64,
              px: f64,
              py: f64,
              pz: f64,
              tx: f64,
              ty: f64,
              tz: f64| {
            let s = accessor(caller.data_mut());
            s.cam_fov = fov as f32;
            s.cam_aspect = aspect as f32;
            s.cam_near = near as f32;
            s.cam_far = far as f32;
            s.cam_pos = [px as f32, py as f32, pz as f32];
            s.cam_target = [tx as f32, ty as f32, tz as f32];
        },
    )?;
    linker.func_wrap(
        "obsid",
        "get_aspect",
        move |mut caller: Caller<'_, T>| -> f64 { accessor(caller.data_mut()).aspect() as f64 },
    )?;
    linker.func_wrap(
        "obsid",
        "set_dir_light",
        move |mut caller: Caller<'_, T>, r: f64, g: f64, b: f64, dx: f64, dy: f64, dz: f64| {
            let s = accessor(caller.data_mut());
            s.sun_color = [r as f32, g as f32, b as f32];
            s.sun_dir = [dx as f32, dy as f32, dz as f32];
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_ambient",
        move |mut caller: Caller<'_, T>, r: f64, g: f64, b: f64| {
            accessor(caller.data_mut()).ambient = [r as f32, g as f32, b as f32];
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_fog",
        move |mut caller: Caller<'_, T>, r: f64, g: f64, b: f64, near: f64, far: f64| {
            let s = accessor(caller.data_mut());
            s.fog_color = [r as f32, g as f32, b as f32];
            s.fog_near = near as f32;
            s.fog_far = far as f32;
        },
    )?;
    linker.func_wrap(
        "obsid",
        "set_point_light",
        move |mut caller: Caller<'_, T>,
              idx: i64,
              x: f64,
              y: f64,
              z: f64,
              r: f64,
              g: f64,
              b: f64,
              range: f64| {
            let i = idx as usize;
            if i < MAX_POINTS {
                let s = accessor(caller.data_mut());
                s.point_pos[i] = [x as f32, y as f32, z as f32];
                s.point_color[i] = [r as f32, g as f32, b as f32];
                s.point_range[i] = range as f32;
                s.point_active[i] = true;
            }
        },
    )?;
    linker.func_wrap(
        "obsid",
        "clear_point_light",
        move |mut caller: Caller<'_, T>, idx: i64| {
            let i = idx as usize;
            if i < MAX_POINTS {
                accessor(caller.data_mut()).point_active[i] = false;
            }
        },
    )?;

    // ── Render ──
    linker.func_wrap("obsid", "render", move |mut caller: Caller<'_, T>| {
        accessor(caller.data_mut()).render_frame_internal();
    })?;

    Ok(())
}
