use std::sync::Arc;

use anyhow::{Context, Result};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use winit::window::Window;

pub const MAX_POINTS: usize = 2;
pub const VERTEX_STRIDE: u64 = 44;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct Uniforms {
    pub vp: [f32; 16],
    pub model: [f32; 16],
    pub eye: [f32; 4],
    pub sun_color: [f32; 4],
    pub sun_dir: [f32; 4],
    pub ambient: [f32; 4],
    pub fog_color: [f32; 4],
    pub fog_range: [f32; 4],
    pub specular: [f32; 4],
    pub point_pos: [[f32; 4]; MAX_POINTS],
    pub point_color: [[f32; 4]; MAX_POINTS],
    pub num_points: [i32; 4],
}

pub struct Mesh {
    pub vb: wgpu::Buffer,
    pub ib: wgpu::Buffer,
    pub index_count: u32,
    pub pos: [f32; 3],
    pub rot: [f32; 3],
    pub scl: [f32; 3],
    pub shininess: f32,
    pub specular: [f32; 3],
    pub alpha: f32,
    pub visible: bool,
}

impl Mesh {
    pub fn new(vb: wgpu::Buffer, ib: wgpu::Buffer, index_count: u32) -> Self {
        Self {
            vb,
            ib,
            index_count,
            pos: [0.0; 3],
            rot: [0.0; 3],
            scl: [1.0, 1.0, 1.0],
            shininess: 32.0,
            specular: [0.0; 3],
            alpha: 1.0,
            visible: true,
        }
    }
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub surface_config: wgpu::SurfaceConfiguration,
    pub pipeline: wgpu::RenderPipeline,
    pub uniforms_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub depth_view: wgpu::TextureView,
    _window: Arc<Window>,
}

impl Gpu {
    pub async fn new(window: Arc<Window>) -> Result<Self> {
        let size = window.inner_size();
        let width = size.width.max(1);
        let height = size.height.max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });
        let surface = instance
            .create_surface(window.clone())
            .context("create wgpu surface")?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .context("request wgpu adapter")?;

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("obsid-native device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .context("request wgpu device")?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &surface_config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("obsid shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()),
        });

        let uniforms_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("obsid uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("obsid bind group layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("obsid bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms_buffer.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("obsid pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let vertex_layout = wgpu::VertexBufferLayout {
            array_stride: VERTEX_STRIDE,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x3,
                },
                wgpu::VertexAttribute {
                    offset: 12,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x3,
                },
                wgpu::VertexAttribute {
                    offset: 24,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32x3,
                },
                wgpu::VertexAttribute {
                    offset: 36,
                    shader_location: 3,
                    format: wgpu::VertexFormat::Float32x2,
                },
            ],
        };

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("obsid pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[vertex_layout],
                compilation_options: Default::default(),
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            multiview: None,
            cache: None,
        });

        let depth_view = create_depth_view(&device, width, height);

        Ok(Self {
            device,
            queue,
            surface,
            surface_config,
            pipeline,
            uniforms_buffer,
            bind_group,
            depth_view,
            _window: window,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);
        self.depth_view = create_depth_view(&self.device, width, height);
    }

    pub fn create_buffer(&self, usage: wgpu::BufferUsages, data: &[u8]) -> wgpu::Buffer {
        self.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: data,
                usage,
            })
    }
}

fn create_depth_view(device: &wgpu::Device, width: u32, height: u32) -> wgpu::TextureView {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("obsid depth"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    tex.create_view(&wgpu::TextureViewDescriptor::default())
}

// ── Matrix helpers (column-major, matching the browser host) ───────────

pub fn mat4_perspective(fov_deg: f32, aspect: f32, near: f32, far: f32) -> [f32; 16] {
    let f = 1.0 / (fov_deg * std::f32::consts::PI / 360.0).tan();
    let nf = 1.0 / (near - far);
    [
        f / aspect, 0.0, 0.0, 0.0,
        0.0, f, 0.0, 0.0,
        0.0, 0.0, (far + near) * nf, -1.0,
        0.0, 0.0, 2.0 * far * near * nf, 0.0,
    ]
}

pub fn mat4_look_at(eye: [f32; 3], center: [f32; 3], up: [f32; 3]) -> [f32; 16] {
    let mut fx = center[0] - eye[0];
    let mut fy = center[1] - eye[1];
    let mut fz = center[2] - eye[2];
    let fl = (fx * fx + fy * fy + fz * fz).sqrt();
    fx /= fl;
    fy /= fl;
    fz /= fl;
    let mut sx = fy * up[2] - fz * up[1];
    let mut sy = fz * up[0] - fx * up[2];
    let mut sz = fx * up[1] - fy * up[0];
    let sl = (sx * sx + sy * sy + sz * sz).sqrt();
    sx /= sl;
    sy /= sl;
    sz /= sl;
    let ux = sy * fz - sz * fy;
    let uy = sz * fx - sx * fz;
    let uz = sx * fy - sy * fx;
    [
        sx, ux, -fx, 0.0,
        sy, uy, -fy, 0.0,
        sz, uz, -fz, 0.0,
        -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
        -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
        fx * eye[0] + fy * eye[1] + fz * eye[2],
        1.0,
    ]
}

pub fn mat4_mul(a: [f32; 16], b: [f32; 16]) -> [f32; 16] {
    let mut o = [0.0f32; 16];
    for c in 0..4 {
        for r in 0..4 {
            let mut s = 0.0f32;
            for k in 0..4 {
                s += a[k * 4 + r] * b[c * 4 + k];
            }
            o[c * 4 + r] = s;
        }
    }
    o
}

pub fn mat4_compose_trs(pos: [f32; 3], rot: [f32; 3], scl: [f32; 3]) -> [f32; 16] {
    let (cx, six) = (rot[0].cos(), rot[0].sin());
    let (cy, siy) = (rot[1].cos(), rot[1].sin());
    let (cz, siz) = (rot[2].cos(), rot[2].sin());
    let (sx, sy, sz) = (scl[0], scl[1], scl[2]);
    [
        (cy * cz) * sx,
        (cy * siz) * sx,
        (-siy) * sx,
        0.0,
        (six * siy * cz - cx * siz) * sy,
        (six * siy * siz + cx * cz) * sy,
        (six * cy) * sy,
        0.0,
        (cx * siy * cz + six * siz) * sz,
        (cx * siy * siz - six * cz) * sz,
        (cx * cy) * sz,
        0.0,
        pos[0], pos[1], pos[2], 1.0,
    ]
}
