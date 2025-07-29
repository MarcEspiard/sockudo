// src/rate_limiter/memory_limiter.rs
use super::{RateLimitConfig, RateLimitResult, RateLimiter};
use crate::error::Result;
use crate::utils::ShutdownSignal;
use async_trait::async_trait;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::interval;
use tracing::{info, warn};
/// Entry in the rate limiter map
#[derive(Clone)]
struct RateLimitEntry {
    /// Current count of requests
    count: u32,
    /// When the window started
    window_start: Instant,
    /// When the window will reset
    expiry: Instant,
}

/// In-memory rate limiter implementation
pub struct MemoryRateLimiter {
    /// Storage for rate limit counters
    limits: Arc<DashMap<String, RateLimitEntry, ahash::RandomState>>,
    /// Configuration for rate limiting
    config: RateLimitConfig,
    /// Cleanup task handle
    cleanup_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Shutdown signal for graceful termination
    shutdown_signal: Option<ShutdownSignal>,
}

impl MemoryRateLimiter {
    /// Create a new memory-based rate limiter
    pub fn new(max_requests: u32, window_secs: u64) -> Self {
        Self::with_config(RateLimitConfig {
            max_requests,
            window_secs,
            identifier: Some("memory".to_string()),
        })
    }

    /// Create a new memory-based rate limiter with a specific configuration
    pub fn with_config(config: RateLimitConfig) -> Self {
        let limits: Arc<DashMap<String, RateLimitEntry, ahash::RandomState>> =
            Arc::new(DashMap::with_hasher(ahash::RandomState::new()));

        Self {
            limits,
            config,
            cleanup_task: Arc::new(Mutex::new(None)),
            shutdown_signal: None,
        }
    }

    /// Set shutdown signal and start the cleanup task
    pub fn set_shutdown_signal(&mut self, shutdown_signal: ShutdownSignal) {
        self.shutdown_signal = Some(shutdown_signal.clone());
        self.start_cleanup_task(shutdown_signal);
    }

    /// Start the cleanup task with shutdown signal support
    fn start_cleanup_task(&self, shutdown_signal: ShutdownSignal) {
        let limits_clone = Arc::clone(&self.limits);
        let task_handle = self.cleanup_task.clone();

        let cleanup_task = tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(10)); // Check every 10 seconds
            
            loop {
                tokio::select! {
                    // Check for shutdown signal
                    _ = shutdown_signal.wait_for_shutdown() => {
                        info!("Rate limiter cleanup task received shutdown signal");
                        break;
                    }
                    // Perform cleanup
                    _ = interval.tick() => {
                        let now = Instant::now();
                        // remove all expired limits
                        limits_clone.retain(|_, value| value.expiry > now);
                    }
                }
            }
            info!("Rate limiter cleanup task shut down");
        });

        // Store the handle
        if let Ok(mut task) = task_handle.try_lock() {
            *task = Some(cleanup_task);
        }
    }

    /// Disconnect and stop the cleanup task
    pub async fn disconnect(&self) -> Result<()> {
        info!("Disconnecting memory rate limiter");

        // Signal shutdown
        if let Some(ref signal) = self.shutdown_signal {
            signal.shutdown();
        }

        // Wait for cleanup task to complete
        {
            let mut task_guard = self.cleanup_task.lock().await;
            if let Some(handle) = task_guard.take() {
                match tokio::time::timeout(Duration::from_secs(3), handle).await {
                    Ok(join_result) => {
                        if let Err(e) = join_result {
                            if !e.is_cancelled() {
                                warn!("Rate limiter cleanup task completed with error: {}", e);
                            }
                        }
                    }
                    Err(_) => {
                        warn!("Rate limiter cleanup task did not complete within timeout");
                    }
                }
            }
        }

        // Clear all limits
        self.limits.clear();
        
        info!("Memory rate limiter disconnected successfully");
        Ok(())
    }
}

#[async_trait]
impl RateLimiter for MemoryRateLimiter {
    async fn check(&self, key: &str) -> Result<RateLimitResult> {
        let now = Instant::now();

        if let Some(entry) = self.limits.get(key) {
            // Check if the window has expired
            if entry.expiry <= now {
                // Window expired, will be cleaned up later
                return Ok(RateLimitResult {
                    allowed: true,
                    remaining: self.config.max_requests,
                    reset_after: self.config.window_secs,
                    limit: self.config.max_requests,
                });
            }

            // Calculate remaining requests and time to reset
            let remaining = self.config.max_requests.saturating_sub(entry.count);
            let reset_after = entry.expiry.saturating_duration_since(now).as_secs();

            Ok(RateLimitResult {
                allowed: remaining > 0,
                remaining,
                reset_after,
                limit: self.config.max_requests,
            })
        } else {
            // No entry yet, so full allowance
            Ok(RateLimitResult {
                allowed: true,
                remaining: self.config.max_requests,
                reset_after: self.config.window_secs,
                limit: self.config.max_requests,
            })
        }
    }

    async fn increment(&self, key: &str) -> Result<RateLimitResult> {
        let now = Instant::now();

        // Try to get or create an entry
        let result = if let Some(mut entry) = self.limits.get_mut(key) {
            // Check if the window has expired
            if entry.expiry <= now {
                // Reset the window
                entry.count = 1;
                entry.window_start = now;
                entry.expiry = now + Duration::from_secs(self.config.window_secs);

                RateLimitResult {
                    allowed: true,
                    remaining: self.config.max_requests - 1,
                    reset_after: self.config.window_secs,
                    limit: self.config.max_requests,
                }
            } else {
                // Increment the counter
                let new_count = entry.count + 1;
                entry.count = new_count;

                let remaining = self.config.max_requests.saturating_sub(new_count);
                let reset_after = entry.expiry.saturating_duration_since(now).as_secs();

                RateLimitResult {
                    allowed: remaining > 0,
                    remaining,
                    reset_after,
                    limit: self.config.max_requests,
                }
            }
        } else {
            // Create a new entry
            let entry = RateLimitEntry {
                count: 1,
                window_start: now,
                expiry: now + Duration::from_secs(self.config.window_secs),
            };

            self.limits.insert(key.to_string(), entry);

            RateLimitResult {
                allowed: true,
                remaining: self.config.max_requests - 1,
                reset_after: self.config.window_secs,
                limit: self.config.max_requests,
            }
        };

        Ok(result)
    }

    async fn reset(&self, key: &str) -> Result<()> {
        self.limits.remove(key);
        Ok(())
    }

    async fn get_remaining(&self, key: &str) -> Result<u32> {
        let now = Instant::now();

        if let Some(entry) = self.limits.get(key) {
            // Check if the window has expired
            if entry.expiry <= now {
                // Window expired, will be cleaned up later
                return Ok(self.config.max_requests);
            }

            // Calculate remaining requests
            let remaining = self.config.max_requests.saturating_sub(entry.count);
            Ok(remaining)
        } else {
            // No entry yet, so full allowance
            Ok(self.config.max_requests)
        }
    }
}

impl Drop for MemoryRateLimiter {
    fn drop(&mut self) {
        // Signal shutdown if we have a signal
        if let Some(ref signal) = self.shutdown_signal {
            signal.shutdown();
        }
        
        // Attempt to abort the cleanup task if it's still running
        if let Ok(mut task_guard) = self.cleanup_task.try_lock() {
            if let Some(task) = task_guard.take() {
                task.abort();
            }
        }
    }
}
