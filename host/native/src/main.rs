use anyhow::Result;

fn main() -> Result<()> {
    let (path, bytes) = obsid_native::load_wasm_from_args("obsid-native")?;
    let title = format!(
        "obsid-native — {}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("wasm")
    );
    obsid_native::run_renderer_only(bytes, title)
}
