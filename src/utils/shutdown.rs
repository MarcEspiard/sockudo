use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Notify, watch};
use tracing::{info, warn};

/// A shutdown signal utility that provides coordinated shutdown across all components
#[derive(Clone, Debug)]
pub struct ShutdownSignal {
    /// Atomic boolean to track shutdown state
    shutdown: Arc<AtomicBool>,
    /// Notifier for additional coordination
    notify: Arc<Notify>,
    /// Watch sender for shutdown signal
    tx: watch::Sender<bool>,
    /// Watch receiver for shutdown signal
    rx: watch::Receiver<bool>,
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownSignal {
    /// Create a new shutdown signal
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            shutdown: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
            tx,
            rx,
        }
    }

    /// Signal shutdown to all components
    pub fn shutdown(&self) {
        info!("Initiating shutdown signal to all components");
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = self.tx.send(true);
        self.notify.notify_waiters();
    }

    /// Check if shutdown has been requested
    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    /// Wait for shutdown signal
    pub async fn wait_for_shutdown(&self) {
        let mut rx = self.rx.clone();
        let _ = rx.wait_for(|&shutdown| shutdown).await;
    }

    /// Wait for shutdown signal with a timeout
    pub async fn wait_for_shutdown_timeout(&self, timeout: std::time::Duration) -> bool {
        let mut rx = self.rx.clone();
        tokio::select! {
            result = rx.wait_for(|&shutdown| shutdown) => result.is_ok(),
            _ = tokio::time::sleep(timeout) => {
                warn!("Shutdown signal wait timed out after {:?}", timeout);
                false
            }
        }
    }

    /// Create a child signal that will be shutdown when this one is
    pub fn child_signal(&self) -> ShutdownSignal {
        // For simplicity, just clone the signal
        // In a more advanced implementation, we could have proper hierarchical shutdown
        self.clone()
    }
}

/// Utility for managing background tasks with proper shutdown
pub struct TaskManager {
    tasks: Vec<tokio::task::JoinHandle<()>>,
    shutdown_signal: ShutdownSignal,
}

impl TaskManager {
    pub fn new(shutdown_signal: ShutdownSignal) -> Self {
        Self {
            tasks: Vec::new(),
            shutdown_signal,
        }
    }

    /// Spawn a task and track it for shutdown
    pub fn spawn<F>(&mut self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let handle = tokio::spawn(future);
        self.tasks.push(handle);
    }

    /// Wait for all tasks to complete or timeout
    pub async fn shutdown_all(&mut self, timeout: std::time::Duration) {
        if self.tasks.is_empty() {
            return;
        }

        info!("Shutting down {} background tasks", self.tasks.len());
        
        // Signal shutdown first
        self.shutdown_signal.shutdown();

        // Wait for tasks to complete or timeout
        let shutdown_future = async {
            for task in self.tasks.drain(..) {
                if let Err(e) = task.await {
                    if !e.is_cancelled() {
                        warn!("Background task completed with error: {}", e);
                    }
                }
            }
        };

        tokio::select! {
            _ = shutdown_future => {
                info!("All background tasks completed successfully");
            }
            _ = tokio::time::sleep(timeout) => {
                warn!("Background tasks shutdown timed out after {:?}, some tasks may still be running", timeout);
                // Abort remaining tasks
                for task in &self.tasks {
                    task.abort();
                }
            }
        }
    }
}

impl Drop for TaskManager {
    fn drop(&mut self) {
        // Abort any remaining tasks on drop
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn test_shutdown_signal() {
        let signal = ShutdownSignal::new();
        assert!(!signal.is_shutdown());

        signal.shutdown();
        assert!(signal.is_shutdown());
    }

    #[tokio::test]
    async fn test_wait_for_shutdown() {
        let signal = ShutdownSignal::new();
        let signal_clone = signal.clone();

        let task = tokio::spawn(async move {
            signal_clone.wait_for_shutdown().await;
        });

        // Give the task a moment to start waiting
        tokio::time::sleep(Duration::from_millis(10)).await;

        signal.shutdown();
        
        // Task should complete now
        assert!(task.await.is_ok());
    }

    #[tokio::test]
    async fn test_child_signal() {
        let parent_signal = ShutdownSignal::new();
        let child_signal = parent_signal.child_signal();

        assert!(!child_signal.is_shutdown());
        
        parent_signal.shutdown();
        
        // Give it a moment to propagate
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(child_signal.is_shutdown());
    }
}