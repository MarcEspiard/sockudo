#![allow(unused_assignments)]
#![allow(unused_variables)]
#![allow(dead_code)]

// src/rate_limiter/redis_limiter.rs
use super::{RateLimitConfig, RateLimitResult, RateLimiter};
use crate::error::{Error, Result};
use async_trait::async_trait;
use redis::{AsyncCommands, Client};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Redis-based rate limiter implementation
pub struct RedisRateLimiter {
    /// Redis client
    client: Client,
    /// Redis connection
    connection: redis::aio::MultiplexedConnection,
    /// Prefix for Redis keys
    prefix: String,
    /// Configuration for rate limiting
    config: RateLimitConfig,
}

impl RedisRateLimiter {
    /// Create a new Redis-based rate limiter
    pub async fn new(
        client: Client,
        prefix: String,
        max_requests: u32,
        window_secs: u64,
    ) -> Result<Self> {
        let connection = client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| Error::Redis(format!("Failed to connect to Redis: {}", e)))?;

        let config = RateLimitConfig {
            max_requests,
            window_secs,
            identifier: Some("redis".to_string()),
        };

        Ok(Self {
            client,
            connection,
            prefix,
            config,
        })
    }

    /// Create a new Redis-based rate limiter with a specific configuration
    pub async fn with_config(
        client: Client,
        prefix: String,
        config: RateLimitConfig,
    ) -> Result<Self> {
        let connection = client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| Error::Redis(format!("Failed to connect to Redis: {}", e)))?;

        Ok(Self {
            client,
            connection,
            prefix,
            config,
        })
    }

    /// Get a key formatted with the prefix
    fn get_key(&self, key: &str) -> String {
        format!("{}:rl:{}", self.prefix, key)
    }

    /// Get the Unix timestamp for the current time
    fn get_current_time() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_else(|_| Duration::from_secs(0))
            .as_secs()
    }

    /// Run sliding window rate limiting using Redis
    /// This uses a sorted set with scores as timestamps
    async fn run_sliding_window_check(
        &self,
        key: &str,
        increment: bool,
    ) -> Result<RateLimitResult> {
        let redis_key = self.get_key(key);
        let now = Self::get_current_time();
        let window_start = now - self.config.window_secs;

        // Get a cloned connection
        let mut conn = self.connection.clone();

        // Remove all elements older than our window
        let _: () = conn
            .zrevrangebyscore(&redis_key, 0, window_start as i64)
            .await
            .map_err(|e| Error::Redis(format!("Failed to clean up Redis sorted set: {}", e)))?;

        // Count current elements in the window
        let count: u32 = conn
            .zcard(&redis_key)
            .await
            .map_err(|e| Error::Redis(format!("Failed to count Redis sorted set: {}", e)))?;

        // Set expiry on the key for automatic cleanup
        let _: () = conn
            .expire(&redis_key, self.config.window_secs as usize as i64)
            .await
            .map_err(|e| Error::Redis(format!("Failed to set expiry on Redis key: {}", e)))?;

        let remaining = self.config.max_requests.saturating_sub(count);
        let allowed = remaining > 0;

        // If we should increment and we're allowed, add the current timestamp
        if increment && allowed {
            let _: () = conn
                .zadd(&redis_key, now, now)
                .await
                .map_err(|e| Error::Redis(format!("Failed to increment Redis counter: {}", e)))?;

            // Recalculate remaining after increment
            let new_remaining = remaining.saturating_sub(1);

            return Ok(RateLimitResult {
                allowed,
                remaining: new_remaining,
                reset_after: self.config.window_secs,
                limit: self.config.max_requests,
            });
        }

        Ok(RateLimitResult {
            allowed,
            remaining,
            reset_after: self.config.window_secs,
            limit: self.config.max_requests,
        })
    }
}

#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn check(&self, key: &str) -> Result<RateLimitResult> {
        self.run_sliding_window_check(key, false).await
    }

    async fn increment(&self, key: &str) -> Result<RateLimitResult> {
        self.run_sliding_window_check(key, true).await
    }

    async fn reset(&self, key: &str) -> Result<()> {
        let redis_key = self.get_key(key);
        let mut conn = self.connection.clone();

        let _: () = conn
            .del(&redis_key)
            .await
            .map_err(|e| Error::Redis(format!("Failed to delete Redis key: {}", e)))?;

        Ok(())
    }

    async fn get_remaining(&self, key: &str) -> Result<u32> {
        let result = self.check(key).await?;
        Ok(result.remaining)
    }

    async fn disconnect(&self) -> Result<()> {
        // Note: Redis MultiplexedConnection doesn't have an explicit disconnect method
        // The connection will be dropped when the client goes out of scope
        // However, we can try to send a QUIT command to cleanly close the connection
        tracing::debug!("RedisRateLimiter disconnect called - attempting clean shutdown");

        // Try to send QUIT command with a timeout to avoid hanging
        let mut conn = self.connection.clone();
        let quit_timeout = Duration::from_millis(1000); // 1 second timeout

        let quit_result = tokio::time::timeout(quit_timeout, async move {
            let _: std::result::Result<(), redis::RedisError> =
                redis::cmd("QUIT").query_async(&mut conn).await;
        })
        .await;

        match quit_result {
            Ok(_) => {
                tracing::debug!("Redis QUIT command sent successfully");
            }
            Err(_) => {
                tracing::warn!("Redis QUIT command timed out - forcing disconnect");
            }
        }

        tracing::debug!("RedisRateLimiter disconnect completed");
        Ok(())
    }
}
