use std::path::PathBuf;

use remux::extensions::manifest::load_extension_manifest;

#[test]
fn agent_manifest_is_discoverable_without_codex_workloads() {
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/agent/remux-extension.json");
    let manifest = load_extension_manifest(&manifest_path).expect("agent manifest should validate");

    assert_eq!(manifest.id, "agent");
    assert_eq!(manifest.main_view().route, "/viewers/agent");
    assert!(manifest.workloads.is_empty());
    assert_eq!(manifest.launchers.len(), 1);
    assert_eq!(manifest.launchers[0].label, "Agent");

    let server = manifest.server.expect("agent has a stdio server");
    assert_eq!(server.transport, "stdio");
    assert_eq!(server.command, "node");
    assert_eq!(server.args, ["server/dist/main.mjs"]);
    assert!(server.build.is_some());
}
