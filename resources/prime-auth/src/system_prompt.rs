use pa_core::prompts::system_prompt::{
    system_prompt_breakdown, BuildSystemPromptOptions, SegmentKind,
};
use serde_json::{json, Value};

pub fn defaults() -> Value {
    let breakdown = system_prompt_breakdown(&BuildSystemPromptOptions::default());
    let text = breakdown
        .segments
        .iter()
        .filter(|segment| segment.kind == SegmentKind::Static)
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    json!({ "text": text })
}

#[cfg(test)]
mod tests {
    use super::defaults;

    #[test]
    fn default_foundation_has_no_session_tail() {
        let result = defaults();
        let text = result["text"].as_str().expect("native foundation text");
        assert!(text.starts_with("# prime-agent harness"));
        assert!(!text.contains("Current working directory:"));
        assert!(!text.contains("Pre-installed Python packages:"));
    }
}
