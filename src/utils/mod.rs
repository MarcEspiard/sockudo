pub mod shutdown;

pub use shutdown::{ShutdownSignal, TaskManager};

// Re-export utility functions that were in the old utils.rs
use std::sync::LazyLock;
use crate::app::config::App;
use crate::error::Error;
use regex::Regex;

// Compile regexes once using lazy_static
static CACHING_CHANNEL_REGEXES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = vec![
        "cache-*",
        "private-cache-*",
        "private-encrypted-cache-*",
        "presence-cache-*",
    ];
    patterns
        .into_iter()
        .map(|pattern| Regex::new(&pattern.replace("*", ".*")).unwrap())
        .collect()
});

pub fn is_cache_channel(channel: &str) -> bool {
    // Use the pre-compiled regexes
    for regex in CACHING_CHANNEL_REGEXES.iter() {
        if regex.is_match(channel) {
            return true;
        }
    }
    false
}

pub fn data_to_bytes<T: AsRef<str> + serde::Serialize>(data: &[T]) -> usize {
    data.iter()
        .map(|element| {
            // Convert element to string representation
            let string_data = element.as_ref().to_string();

            // Calculate byte length of string
            string_data.len()
        })
        .sum()
}

pub fn data_to_bytes_flexible(data: Vec<serde_json::Value>) -> usize {
    data.iter().fold(0, |total_bytes, element| {
        let element_str = if element.is_string() {
            // Use string value directly if it's a string
            element.as_str().unwrap_or_default().to_string()
        } else {
            // Convert to JSON string for other types
            serde_json::to_string(element).unwrap_or_default()
        };

        // Add byte length, handling potential encoding errors
        // No specific error handling for as_bytes().len() as it's inherent to string length.
        total_bytes + element_str.len()
    })
}

pub async fn validate_channel_name(app: &App, channel: &str) -> crate::error::Result<()> {
    if channel.len() > app.max_channel_name_length.unwrap_or(200) as usize {
        return Err(Error::Channel(format!(
            "Channel name too long. Max length is {}",
            app.max_channel_name_length.unwrap_or(200)
        )));
    }
    if !channel.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || c == '-'
            || c == '_'
            || c == '='
            || c == '@'
            || c == '.'
            || c == ':'
    }) {
        return Err(Error::Channel(
            "Channel name contains invalid characters".to_string(),
        ));
    }

    Ok(())
}