fn main() {
    let version = std::env::var("WHK_VERSION").unwrap_or_else(|_| "dev".to_string());
    println!("cargo:rustc-env=WHK_VERSION={version}");
}
