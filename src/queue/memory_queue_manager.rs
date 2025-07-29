// --- MemoryQueueManager ---
// No major logical changes, but added comments and ensured consistency.

use crate::queue::{ArcJobProcessorFn, QueueInterface};
use crate::webhook::sender::JobProcessorFnAsync;
use crate::webhook::types::JobData;
use crate::utils::ShutdownSignal;
use async_trait::async_trait;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Memory-based queue manager for simple deployments
pub struct MemoryQueueManager {
    // Use channels to simulate a queue in memory
    // DashMap<String, Vec<JobData>> is implicitly Send + Sync if JobData is Send
    queues: Arc<DashMap<String, Vec<JobData>, ahash::RandomState>>,
    // Store Arc'd callbacks to be consistent with Redis manager and avoid potential issues if Box wasn't 'static
    processors: Arc<DashMap<String, ArcJobProcessorFn, ahash::RandomState>>,
    // Shutdown signal for graceful termination
    shutdown_signal: Option<ShutdownSignal>,
    // Background task handle
    task_handle: Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>,
}

impl MemoryQueueManager {
    pub fn new() -> Self {
        let queues = Arc::new(DashMap::with_hasher(ahash::RandomState::new()));
        let processors = Arc::new(DashMap::with_hasher(ahash::RandomState::new()));

        Self { 
            queues, 
            processors,
            shutdown_signal: None,
            task_handle: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub fn set_shutdown_signal(&mut self, shutdown_signal: ShutdownSignal) {
        self.shutdown_signal = Some(shutdown_signal);
    }

    /// Starts the background processing loop. Should be called once after setup.
    pub fn start_processing(&self) {
        // Clone Arcs for the background task
        let queues = Arc::clone(&self.queues);
        let processors = Arc::clone(&self.processors);
        let shutdown_signal = self.shutdown_signal.clone();
        let task_handle = self.task_handle.clone();

        info!("{}", "Starting memory queue processing loop...".to_string());

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));

            loop {
                tokio::select! {
                    // Check for shutdown signal
                    _ = async {
                        if let Some(ref signal) = shutdown_signal {
                            signal.wait_for_shutdown().await;
                        } else {
                            let _: () = std::future::pending().await;
                        }
                    } => {
                        info!("Memory queue processing received shutdown signal");
                        break;
                    }
                    // Process jobs
                    _ = interval.tick() => {
                        // Iterate through queues. DashMap allows concurrent access.
                        for queue_entry in queues.iter() {
                            // Use iter() for read access
                            let queue_name = queue_entry.key();

                            // Get the processor for this queue
                            if let Some(processor) = processors.get(queue_name) {
                                // Get a mutable reference to the queue's Vec
                                if let Some(mut jobs_vec) = queues.get_mut(queue_name) {
                                    // Take all jobs from the queue for this tick
                                    // Note: If a job processor is slow, it blocks others in the same queue during this tick.
                                    // Consider spawning tasks per job for better isolation if needed.

                                    if !jobs_vec.is_empty() {
                                        info!(
                                            "{}",
                                            format!(
                                                "Processing {} jobs from memory queue {}",
                                                jobs_vec.len(),
                                                queue_name
                                            )
                                        );
                                        // Process each job sequentially within this tick
                                        for job in jobs_vec.drain(..) {
                                            // Clone the Arc'd processor for the call
                                            let processor_clone = Arc::clone(&processor);
                                            match processor_clone(job).await {
                                                Ok(_) => {},
                                                Err(e) => warn!("Failed to process job: {}", e),
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            info!("Memory queue processing loop shut down");
        });

        // Store the handle
        if let Ok(mut task) = task_handle.try_lock() {
            *task = Some(handle);
        }
    }
}

#[async_trait]
impl QueueInterface for MemoryQueueManager {
    async fn add_to_queue(&self, queue_name: &str, data: JobData) -> crate::error::Result<()> {
        // Ensure queue Vec exists using entry API for atomicity
        self.queues
            .entry(queue_name.to_string())
            .or_default()
            .push(data);
        Ok(())
    }

    async fn process_queue(
        &self,
        queue_name: &str,
        callback: JobProcessorFnAsync,
    ) -> crate::error::Result<()> {
        // Ensure the queue Vec exists (might be redundant if add_to_queue is always called first, but safe)
        self.queues.entry(queue_name.to_string()).or_default();

        // Register processor, wrapping it in Arc
        self.processors
            .insert(queue_name.to_string(), Arc::from(callback)); // Store as Arc
        info!(
            "{}",
            format!("Registered processor for memory queue: {}", queue_name)
        );

        Ok(())
    }

    async fn disconnect(&self) -> crate::error::Result<()> {
        info!("Disconnecting memory queue manager");

        // Signal shutdown to background task
        if let Some(ref signal) = self.shutdown_signal {
            signal.shutdown();
        }

        // Wait for the background task to complete
        {
            let mut task_guard = self.task_handle.lock().await;
            if let Some(handle) = task_guard.take() {
                match tokio::time::timeout(Duration::from_secs(3), handle).await {
                    Ok(join_result) => {
                        if let Err(e) = join_result {
                            if !e.is_cancelled() {
                                warn!("Memory queue processing task completed with error: {}", e);
                            }
                        }
                    }
                    Err(_) => {
                        warn!("Memory queue processing task did not complete within timeout");
                    }
                }
            }
        }

        // Clear all queues
        self.queues.clear();
        
        info!("Memory queue manager disconnected successfully");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::JobData;
    use crate::webhook::types::JobPayload;

    #[tokio::test]
    async fn test_add_to_queue() {
        let manager = MemoryQueueManager::new();
        let data = JobData {
            app_key: "test_key".to_string(),
            app_id: "test_id".to_string(),
            app_secret: "test_secret".to_string(),
            payload: JobPayload {
                time_ms: chrono::Utc::now().timestamp_millis(),
                events: vec![],
            },
            original_signature: "test_signature".to_string(),
        };

        manager
            .add_to_queue("test_queue", data.clone())
            .await
            .unwrap();

        assert_eq!(manager.queues.get("test_queue").unwrap().len(), 1);
    }

    //todo think how to test process_queue

    #[tokio::test]
    async fn test_disconnect() {
        let manager = MemoryQueueManager::new();
        let data = JobData {
            app_key: "test_key".to_string(),
            app_id: "test_id".to_string(),
            app_secret: "test_secret".to_string(),
            payload: JobPayload {
                time_ms: chrono::Utc::now().timestamp_millis(),
                events: vec![],
            },
            original_signature: "test_signature".to_string(),
        };

        manager.add_to_queue("test_queue", data).await.unwrap();
        assert!(!manager.queues.is_empty());

        manager.disconnect().await.unwrap();
        assert!(manager.queues.is_empty());
    }
}
