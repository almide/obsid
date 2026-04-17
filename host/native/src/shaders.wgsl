// obsid native host — Blinn-Phong with directional + 2 point lights, fog,
// sRGB gamma. Ported from host/browser/obsid.js.
//
// Uniform buffer layout is padded to vec4 everywhere so it maps cleanly onto
// the Rust side struct with #[repr(C)] + std140-compatible fields.

const MAX_POINTS: i32 = 2;

struct Uniforms {
    vp: mat4x4<f32>,
    model: mat4x4<f32>,
    eye: vec4<f32>,          // xyz = camera pos, w unused
    sun_color: vec4<f32>,    // rgb, w unused
    sun_dir: vec4<f32>,      // xyz, w unused
    ambient: vec4<f32>,      // rgb, w unused
    fog_color: vec4<f32>,    // rgb, w unused
    // x = near, y = far, z = shininess, w = alpha
    fog_range: vec4<f32>,
    specular: vec4<f32>,     // rgb, w unused
    point_pos: array<vec4<f32>, MAX_POINTS>,     // xyz = pos, w = range
    point_color: array<vec4<f32>, MAX_POINTS>,   // rgb, w unused
    // x = active point count, yzw unused
    num_points: vec4<i32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wpos: vec3<f32>,
    @location(1) n: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) dist: f32,
};

@vertex
fn vs_main(
    @location(0) a_pos: vec3<f32>,
    @location(1) a_norm: vec3<f32>,
    @location(2) a_color: vec3<f32>,
    @location(3) a_uv: vec2<f32>,
) -> VOut {
    var out: VOut;
    let world = u.model * vec4<f32>(a_pos, 1.0);
    out.wpos = world.xyz;
    let normal_mat = mat3x3<f32>(u.model[0].xyz, u.model[1].xyz, u.model[2].xyz);
    out.n = normal_mat * a_norm;
    out.color = a_color;
    out.dist = length(world.xyz - u.eye.xyz);
    out.pos = u.vp * world;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(1.0 / 2.2)); }

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
    let n = normalize(in.n);
    let view_dir = normalize(u.eye.xyz - in.wpos);
    let shininess = u.fog_range.z;
    let alpha = u.fog_range.w;

    let base = srgb_to_linear(in.color);

    // Directional (sun) — Lambert + Blinn-Phong in linear light.
    let sun_color_l = srgb_to_linear(u.sun_color.xyz);
    let sun_dir_n = normalize(u.sun_dir.xyz);
    let sun_diff = max(dot(n, sun_dir_n), 0.0);
    let sun_half = normalize(sun_dir_n + view_dir);
    var sun_spec: f32 = 0.0;
    if (sun_diff > 0.0) {
        sun_spec = pow(max(dot(n, sun_half), 0.0), shininess);
    }

    var lighting = srgb_to_linear(u.ambient.xyz) + sun_color_l * sun_diff;
    var specular = sun_color_l * sun_spec;

    // Point lights — same attenuation curve the browser host uses.
    let num_points = u.num_points.x;
    for (var i: i32 = 0; i < MAX_POINTS; i = i + 1) {
        if (i >= num_points) { break; }
        let pp = u.point_pos[i].xyz;
        let pr = u.point_pos[i].w;
        let pc = srgb_to_linear(u.point_color[i].xyz);
        let to_light = pp - in.wpos;
        let dist = length(to_light);
        let dir = to_light / dist;
        var atten = clamp(1.0 - dist / pr, 0.0, 1.0);
        atten = atten * atten;
        let d = max(dot(n, dir), 0.0);
        let hv = normalize(dir + view_dir);
        var s: f32 = 0.0;
        if (d > 0.0) {
            s = pow(max(dot(n, hv), 0.0), shininess);
        }
        lighting = lighting + pc * d * atten;
        specular = specular + pc * s * atten;
    }

    var color = base * lighting + specular * u.specular.xyz;

    // Fog in linear space.
    let fog = clamp((u.fog_range.y - in.dist) / (u.fog_range.y - u.fog_range.x), 0.0, 1.0);
    color = mix(srgb_to_linear(u.fog_color.xyz), color, fog);

    return vec4<f32>(linear_to_srgb(color), alpha);
}
