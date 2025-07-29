use crate::queue::{ArcJobProcessorFn, QueueInterface};
use crate::webhook::sender::JobProcessorFnAsync;
use crate::webhook::types::JobData;
use crate::utils::ShutdownSignal;
use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::{AsyncCommands, RedisResult};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

pub struct RedisQueueManager {
    redis_connection: Arc<Mutex<MultiplexedConnection>>,
    // Store Arc'd callbacks to allow cloning them into worker tasks safely
    job_processors: dashmap::DashMap<String, ArcJobProcessorFn, ahash::RandomState>,
    prefix: String,
    concurrency: usize,
    // Store worker task handles for proper shutdown
    worker_handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
    shutdown_signal: Option<ShutdownSignal>,
}

impl RedisQueueManager {
    /// Creates a new RedisQueueManager instance.
    /// Connects to Redis and returns a Result.
    pub async fn new(
        redis_url: &str,
        prefix: &str,
        concurrency: usize,
    ) -> crate::error::Result<Self> {
        let client = redis::Client::open(redis_url).map_err(|e| {
            crate::error::Error::Config(format!("Failed to open Redis client: {}", e))
        })?; // Use custom error type

        let connection = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| {
                crate::error::Error::Connection(format!("Failed to get Redis connection: {}", e))
            })?; // Use custom error type

        Ok(Self {
            redis_connection: Arc::new(Mutex::new(connection)),
            job_processors: dashmap::DashMap::with_hasher(ahash::RandomState::new()),
            prefix: prefix.to_string(),
            concurrency,
            worker_handles: Arc::new(Mutex::new(Vec::new())),
            shutdown_signal: None,
        })
    }

    // Note: start_processing is effectively done within process_queue for Redis
    #[allow(dead_code)]
    pub fn start_processing(&self) {
        // This method is not strictly needed for Redis as workers start in process_queue.
        // Could be used for other setup if required in the future.
    }

    pub fn set_shutdown_signal(&mut self, shutdown_signal: ShutdownSignal) {
        self.shutdown_signal = Some(shutdown_signal);
    }

    async fn format_key(&self, queue_name: &str) -> String {
        format!("{}:queue:{}", self.prefix, queue_name)
    }
}

#[async_trait]
impl QueueInterface for RedisQueueManager {
    /// Adds a job to the specified Redis queue (list).
    /// Serializes the job data to JSON.
    async fn add_to_queue(&self, queue_name: &str, data: JobData) -> crate::error::Result<()>
    where
        JobData: Serialize, // Ensure JobData can be serialized
    {
        let queue_key = self.format_key(queue_name).await;
        let data_json = serde_json::to_string(&data)?; // Propagate serialization error

        let mut conn = self.redis_connection.lock().await;

        // Perform RPUSH and handle potential Redis errors
        conn.rpush::<_, _, ()>(&queue_key, data_json)
            .await
            .map_err(|e| {
                crate::error::Error::Queue(format!(
                    "Redis RPUSH failed for queue {}: {}",
                    queue_name, e
                ))
            })?; // Use custom error type

        // info!("{}", format!("Added job to Redis queue: {}", queue_name)); // Optional: reduce log verbosity

        Ok(())
    }

    /// Registers a callback for a queue and starts worker tasks to process jobs.
    async fn process_queue(
        &self,
        queue_name: &str,
        callback: JobProcessorFnAsync,
    ) -> crate::error::Result<()>
    where
        JobData: DeserializeOwned + Send + 'static, // Ensure JobData can be deserialized and sent across threads
    {
        let queue_key = self.format_key(queue_name).await;

        // Wrap the callback in an Arc to share it safely with multiple worker tasks
        let processor_arc: ArcJobProcessorFn = Arc::from(callback);

        // Store the Arc'd callback
        self.job_processors
            .insert(queue_name.to_string(), processor_arc.clone());
        info!(
            "{}",
            format!(
                "Registered processor and starting workers for Redis queue: {}",
                queue_name
            )
        );

        // Start worker tasks
        let mut handles = Vec::new();
        for i in 0..self.concurrency {
            let worker_queue_key = queue_key.clone();
            let worker_redis_conn = self.redis_connection.clone();
            let worker_processor = processor_arc.clone(); // Clone the Arc for this worker
            let worker_queue_name = queue_name.to_string(); // Clone queue name for logging
            let shutdown_signal = self.shutdown_signal.clone();

            let handle = tokio::spawn(async move {
                info!(
                    "{}",
                    format!(
                        "Starting Redis queue worker {} for queue: {}",
                        i, worker_queue_name
                    )
                );

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
                            info!("Redis queue worker {} for queue {} received shutdown signal", i, worker_queue_name);
                            break;
                        }
                        // Process jobs
                        blpop_result = async {
                            let mut conn = worker_redis_conn.lock().await;
                            // Use BLPOP with a timeout (e.g., 0.01 second)
                            let result: RedisResult<Option<(String, String)>> = conn.blpop(&worker_queue_key, 0.01).await;
                            result
                        } => {
                            match blpop_result {
                                // Successfully received a job
                                Ok(Some((_key, job_data_str))) => {
                                    match serde_json::from_str::<JobData>(&job_data_str) {
                                        Ok(job_data) => {
                                            // Execute the job processing callback
                                            match worker_processor(job_data).await {
                                                Ok(_) => {
                                                    info!("{}", "Worker finished".to_string());
                                                }
                                                Err(e) => {
                                                    error!("{}", format!("Worker error: {}", e));
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            // Failed to deserialize the job data
                                            error!(
                                                "{}",
                                                format!(
                                                    "[Worker {}] Error deserializing job data from Redis queue {}: {}. Data: '{}'",
                                                    i, worker_queue_name, e, job_data_str
                                                )
                                            );
                                            // Potential: Move corrupted data to a specific place?
                                        }
                                    }
                                }
                                // BLPOP timed out, no job available
                                Ok(None) => {
                                    // Continue loop to wait again
                                    continue;
                                }
                                // Redis error during BLPOP
                                Err(e) => {
                                    error!(
                                        "{}",
                                        format!(
                                            "[Worker {}] Redis BLPOP error on queue {}: {}",
                                            i, worker_queue_name, e
                                        )
                                    );
                                    // Avoid hammering Redis on persistent errors
                                    tokio::time::sleep(Duration::from_secs(1)).await;
                                }
                            }
                        }
                    }
                }
                info!("Redis queue worker {} for queue {} shut down", i, worker_queue_name);
            });

            handles.push(handle);
        }

        // Store the handles for proper shutdown
        {
            let mut worker_handles = self.worker_handles.lock().await;
            worker_handles.extend(handles);
        }

        Ok(())
    }

    async fn disconnect(&self) -> crate::error::Result<()> {
        info!("Disconnecting Redis queue manager");

        // Signal workers to shutdown
        if let Some(ref signal) = self.shutdown_signal {
            signal.shutdown();
        }

        // Wait for workers to finish
        {
            let mut worker_handles = self.worker_handles.lock().await;
            let handles = std::mem::take(&mut *worker_handles);
            for handle in handles {
                match tokio::time::timeout(Duration::from_secs(3), handle).await {
                    Ok(join_result) => {
                        if let Err(e) = join_result {
                            if !e.is_cancelled() {
                                warn!("Redis queue worker completed with error: {}", e);
                            }
                        }
                    }
                    Err(_) => {
                        warn!("Redis queue worker did not complete within timeout");
                    }
                }
            }
        }

        // Clean up Redis queues
        let mut conn = self.redis_connection.lock().await;
        let keys: Vec<String> = conn
            .keys(format!("{}:queue:*", self.prefix))
            .await
            .map_err(|e| {
                crate::error::Error::Queue(format!(
                    "Redis disconnect error fetching keys: {}",
                    e
                ))
            })?;
        for key in keys {
            if let Err(e) = conn.del::<_, ()>(&key).await {
                error!("Error deleting key {} during disconnect: {}", key, e);
            }
        }

        info!("Redis queue manager disconnected successfully");
        Ok(())
    }
}
