use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::adapter::Adapter;
use crate::adapter::local_adapter::LocalAdapter;
use crate::channel::PresenceMemberInfo;
use crate::error::{Error, Result};

use crate::metrics::MetricsInterface;
use crate::websocket::SocketId;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::{info, warn, error};
use uuid::Uuid;

/// Request types for horizontal communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RequestType {
    // Original request types
    ChannelMembers,           // Get members in a channel
    ChannelSockets,           // Get sockets in a channel
    ChannelSocketsCount,      // Get count of sockets in a channel
    SocketExistsInChannel,    // Check if socket exists in a channel
    TerminateUserConnections, // Terminate user connections
    ChannelsWithSocketsCount, // Get channels with socket counts

    // New request types
    Sockets,             // Get all sockets
    Channels,            // Get all channels
    SocketsCount,        // Get count of all sockets
    ChannelMembersCount, // Get count of members in a channel
}

/// Request body for horizontal communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestBody {
    pub request_id: String,
    pub node_id: String,
    pub app_id: String,
    pub request_type: RequestType,
    pub channel: Option<String>,
    pub socket_id: Option<String>,
    pub user_id: Option<String>,
}

/// Response body for horizontal requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseBody {
    pub request_id: String,
    pub node_id: String,
    pub app_id: String,
    pub members: HashMap<String, PresenceMemberInfo>,
    pub channels_with_sockets_count: HashMap<String, usize>,
    pub socket_ids: Vec<String>,
    pub sockets_count: usize,
    pub exists: bool,
    pub channels: HashSet<String>,
    pub members_count: usize, // New field for ChannelMembersCount
}

/// Message for broadcasting events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastMessage {
    pub node_id: String,
    pub app_id: String,
    pub channel: String,
    pub message: String,
    pub except_socket_id: Option<String>,
}

/// Request tracking struct
#[derive(Clone)]
pub struct PendingRequest {
    start_time: Instant,
    app_id: String,
    responses: Vec<ResponseBody>,
}

/// Base horizontal adapter
pub struct HorizontalAdapter {
    /// Unique node ID
    pub node_id: String,

    /// Local adapter for handling local connections
    pub local_adapter: LocalAdapter,

    /// Pending requests map - Use DashMap for thread-safe access
    pub pending_requests: DashMap<String, PendingRequest>,

    /// Timeout for requests in milliseconds
    pub requests_timeout: u64,

    pub metrics: Option<Arc<Mutex<dyn MetricsInterface + Send + Sync>>>,
}

impl HorizontalAdapter {
    /// Create a new horizontal adapter
    pub fn new() -> Self {
        Self {
            node_id: Uuid::new_v4().to_string(),
            local_adapter: LocalAdapter::new(),
            pending_requests: DashMap::new(),
            requests_timeout: 5000, // Default 5 seconds
            metrics: None,
        }
    }

    /// Start the request cleanup task
    pub fn start_request_cleanup(&mut self) {
        // Clone data needed for the task
        let node_id = self.node_id.clone();
        let timeout = self.requests_timeout;
        let pending_requests_clone = self.pending_requests.clone();

        // Spawn a background task to clean up stale requests
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_millis(1000)).await;

                // Find and process expired requests
                let now = Instant::now();
                let mut expired_requests = Vec::new();

                // We can't modify pending_requests while iterating
                for entry in &pending_requests_clone {
                    let request_id = entry.key();
                    let request = entry.value();

                    // Add grace period to prevent interference with active requests
                    let grace_period_ms = 1000; // 1 second grace period
                    let total_timeout = timeout + grace_period_ms;

                    if now.duration_since(request.start_time).as_millis() > total_timeout as u128 {
                        expired_requests.push(request_id.clone());
                    }
                }

                // Process expired requests
                for request_id in expired_requests {
                    if let Some((_, expired_request)) = pending_requests_clone.remove(&request_id) {
                        warn!(
                            "Request {} expired after {}ms with {} responses for app {}",
                            request_id,
                            now.duration_since(expired_request.start_time).as_millis(),
                            expired_request.responses.len(),
                            expired_request.app_id
                        );
                    }
                }
            }
        });
    }

    /// Process a received request from another node
    pub async fn process_request(&mut self, request: RequestBody) -> Result<ResponseBody> {
        info!(
            "Processing request from node {}: {:?} for app {}",
            request.node_id, request.request_type, request.app_id
        );

        // Skip processing our own requests
        if request.node_id == self.node_id {
            return Err(Error::OwnRequestIgnored);
        }

        // Initialize empty response
        let mut response = ResponseBody {
            request_id: request.request_id.clone(),
            node_id: self.node_id.clone(),
            app_id: request.app_id.clone(),
            members: HashMap::new(),
            socket_ids: Vec::new(),
            sockets_count: 0,
            channels_with_sockets_count: HashMap::new(),
            exists: false,
            channels: HashSet::new(),
            members_count: 0,
        };

        // Process based on request type
        match request.request_type {
            RequestType::ChannelMembers => {
                if let Some(channel) = &request.channel {
                    // Get channel members from local adapter
                    match self
                        .local_adapter
                        .get_channel_members(&request.app_id, channel)
                        .await
                    {
                        Ok(members) => {
                            response.members = members;
                        }
                        Err(e) => {
                            error!("Failed to get channel members: {}", e);
                            return Err(e);
                        }
                    }
                }
            }
            RequestType::ChannelSockets => {
                if let Some(channel) = &request.channel {
                    // Get channel sockets from local adapter
                    match self
                        .local_adapter
                        .get_channel(&request.app_id, channel)
                        .await
                    {
                        Ok(channel_set) => {
                            response.socket_ids = channel_set
                                .iter()
                                .map(|socket_id| socket_id.0.clone())
                                .collect();
                            response.sockets_count = response.socket_ids.len();
                        }
                        Err(e) => {
                            error!("Failed to get channel sockets: {}", e);
                            return Err(e);
                        }
                    }
                }
            }
            RequestType::ChannelSocketsCount => {
                if let Some(channel) = &request.channel {
                    // Get channel socket count from local adapter
                    response.sockets_count = self
                        .local_adapter
                        .get_channel_socket_count(&request.app_id, channel)
                        .await;
                }
            }
            RequestType::SocketExistsInChannel => {
                if let (Some(channel), Some(socket_id)) = (&request.channel, &request.socket_id) {
                    // Check if socket exists in channel
                    let socket_id = SocketId(socket_id.clone());
                    match self
                        .local_adapter
                        .is_in_channel(&request.app_id, channel, &socket_id)
                        .await
                    {
                        Ok(exists) => {
                            response.exists = exists;
                        }
                        Err(e) => {
                            error!("Failed to check socket existence: {}", e);
                            return Err(e);
                        }
                    }
                }
            }
            RequestType::TerminateUserConnections => {
                if let Some(user_id) = &request.user_id {
                    // Terminate user connections locally
                    match self
                        .local_adapter
                        .terminate_user_connections(&request.app_id, user_id)
                        .await
                    {
                        Ok(_) => {
                            response.exists = true;
                        }
                        Err(e) => {
                            error!("Failed to terminate user connections: {}", e);
                            return Err(e);
                        }
                    }
                }
            }
            RequestType::ChannelsWithSocketsCount => {
                // Get channels with socket count from local adapter
                match self
                    .local_adapter
                    .get_channels_with_socket_count(&request.app_id)
                    .await
                {
                    Ok(channels) => {
                        response.channels_with_sockets_count = channels
                            .iter()
                            .map(|entry| (entry.key().clone(), *entry.value()))
                            .collect();
                    }
                    Err(e) => {
                        error!("Failed to get channels with socket count: {}", e);
                        return Err(e);
                    }
                }
            }
            // New request types
            RequestType::Sockets => {
                // Get all connections for the app
                let connections = self
                    .local_adapter
                    .get_all_connections(&request.app_id)
                    .await;
                response.socket_ids = connections
                    .iter()
                    .map(|entry| entry.key().0.clone())
                    .collect();
                response.sockets_count = connections.len();
            }
            RequestType::Channels => {
                // Get all channels for the app
                match self
                    .local_adapter
                    .get_channels_with_socket_count(&request.app_id)
                    .await
                {
                    Ok(channels) => {
                        response.channels = channels.iter().map(|entry| entry.key().clone()).collect();
                    }
                    Err(e) => {
                        error!("Failed to get channels: {}", e);
                        return Err(e);
                    }
                }
            }
            RequestType::SocketsCount => {
                // Get count of all sockets
                let connections = self
                    .local_adapter
                    .get_all_connections(&request.app_id)
                    .await;
                response.sockets_count = connections.len();
            }
            RequestType::ChannelMembersCount => {
                if let Some(channel) = &request.channel {
                    // Get count of members in a channel
                    match self
                        .local_adapter
                        .get_channel_members(&request.app_id, channel)
                        .await
                    {
                        Ok(members) => {
                            response.members_count = members.len();
                        }
                        Err(e) => {
                            error!("Failed to get channel members count: {}", e);
                            return Err(e);
                        }
                    }
                }
            }
        }

        // Return the response
        Ok(response)
    }

    /// Process a response received from another node
    pub async fn process_response(&self, response: ResponseBody) -> Result<()> {
        // Track received response
        if let Some(metrics_ref) = &self.metrics {
            let metrics = metrics_ref.lock().await;
            metrics.mark_horizontal_adapter_response_received(&response.app_id);
        }

        // Get the pending request
        if let Some(mut request) = self.pending_requests.get_mut(&response.request_id) {
            // Add response to the list
            let request_id = response.request_id.clone();
            request.responses.push(response);
            info!(
                "Received response for request {}, total responses: {}",
                request_id,
                request.responses.len()
            );
        } else {
            warn!("Received response for unknown request: {}", response.request_id);
        }

        Ok(())
    }

    /// Aggregate responses from multiple nodes into a single combined response
    pub fn aggregate_responses(
        &self,
        request_id: String,
        node_id: String,
        app_id: String,
        request_type: &RequestType,
        responses: Vec<ResponseBody>,
    ) -> ResponseBody {
        let mut combined_response = ResponseBody {
            request_id,
            node_id,
            app_id,
            members: HashMap::new(),
            socket_ids: Vec::new(),
            sockets_count: 0,
            channels_with_sockets_count: HashMap::new(),
            exists: false,
            channels: HashSet::new(),
            members_count: 0,
        };

        if responses.is_empty() {
            return combined_response;
        }

        // Track unique socket IDs to avoid duplicates when aggregating
        let mut unique_socket_ids = HashSet::new();

        for response in responses {
            match request_type {
                RequestType::ChannelMembers => {
                    // Merge members - later responses can overwrite earlier ones with same user_id
                    // This handles the case where a user might be connected to multiple nodes
                    combined_response.members.extend(response.members);
                }

                RequestType::ChannelSockets => {
                    // Collect unique socket IDs across all nodes
                    for socket_id in response.socket_ids {
                        unique_socket_ids.insert(socket_id);
                    }
                }

                RequestType::ChannelSocketsCount => {
                    // Sum socket counts from all nodes
                    combined_response.sockets_count += response.sockets_count;
                }

                RequestType::SocketExistsInChannel => {
                    // If any node reports the socket exists, it exists
                    combined_response.exists = combined_response.exists || response.exists;
                }

                RequestType::TerminateUserConnections => {
                    // If any node successfully terminated connections, mark as success
                    combined_response.exists = combined_response.exists || response.exists;
                }

                RequestType::ChannelsWithSocketsCount => {
                    // FIXED: Actually add the socket counts instead of just inserting 0
                    for (channel, socket_count) in response.channels_with_sockets_count {
                        *combined_response
                            .channels_with_sockets_count
                            .entry(channel)
                            .or_insert(0) += socket_count;
                    }
                }

                RequestType::Sockets => {
                    // Collect unique socket IDs and sum total count
                    for socket_id in response.socket_ids {
                        unique_socket_ids.insert(socket_id);
                    }
                    combined_response.sockets_count += response.sockets_count;
                }

                RequestType::Channels => {
                    // Union of all channels across nodes
                    combined_response.channels.extend(response.channels);
                }

                RequestType::SocketsCount => {
                    // Sum socket counts from all nodes
                    combined_response.sockets_count += response.sockets_count;
                }

                RequestType::ChannelMembersCount => {
                    // FIXED: Actually sum the members count
                    combined_response.members_count += response.members_count;
                }
            }
        }

        // Convert unique socket IDs back to Vec for responses that need it
        if matches!(
            request_type,
            RequestType::ChannelSockets | RequestType::Sockets
        ) {
            combined_response.socket_ids = unique_socket_ids.into_iter().collect();
            // Update sockets_count to reflect unique count for these request types
            if matches!(request_type, RequestType::ChannelSockets) {
                combined_response.sockets_count = combined_response.socket_ids.len();
            }
        }

        combined_response
    }

    /// Helper method to validate response consistency
    pub fn validate_aggregated_response(&self, response: &ResponseBody, request_type: &RequestType) -> Result<()> {
        match request_type {
            RequestType::ChannelSocketsCount | RequestType::SocketsCount => {
                if response.sockets_count == 0 && !response.socket_ids.is_empty() {
                    warn!("Inconsistent response: sockets_count is 0 but socket_ids is not empty");
                }
            }
            RequestType::ChannelMembersCount => {
                if response.members_count == 0 && !response.members.is_empty() {
                    warn!("Inconsistent response: members_count is 0 but members map is not empty");
                }
            }
            RequestType::ChannelsWithSocketsCount => {
                let total_from_channels: usize = response.channels_with_sockets_count.values().sum();
                if total_from_channels == 0 && response.sockets_count > 0 {
                    warn!("Inconsistent response: channels show 0 sockets but sockets_count > 0");
                }
            }
            _ => {} // No specific validation needed for other types
        }

        Ok(())
    }

    /// Send a request to other nodes and wait for responses
    pub async fn send_request(
        &mut self,
        app_id: &str,
        request_type: RequestType,
        channel: Option<&str>,
        socket_id: Option<&str>,
        user_id: Option<&str>,
        expected_node_count: usize,
    ) -> Result<ResponseBody> {
        let request_id = Uuid::new_v4().to_string();
        let start = Instant::now();

        // Create the request
        let request = RequestBody {
            request_id: request_id.clone(),
            node_id: self.node_id.clone(),
            app_id: app_id.to_string(),
            request_type: request_type.clone(),
            channel: channel.map(String::from),
            socket_id: socket_id.map(String::from),
            user_id: user_id.map(String::from),
        };

        // Add to pending requests with proper initialization
        self.pending_requests.insert(
            request_id.clone(),
            PendingRequest {
                start_time: start,
                app_id: app_id.to_string(),
                responses: Vec::with_capacity(expected_node_count.saturating_sub(1)),
            },
        );

        // Serialize and broadcast request
        let request_json = serde_json::to_string(&request)
            .map_err(|e| Error::Other(format!("Failed to serialize request: {}", e)))?;

        // Track sent request in metrics
        if let Some(metrics_ref) = &self.metrics {
            let metrics = metrics_ref.lock().await;
            metrics.mark_horizontal_adapter_request_sent(app_id);
        }

        // TODO: Implement actual broadcasting based on your transport layer
        // Examples:
        // - Redis: PUBLISH to a channel
        // - NATS: publish to subject
        // - HTTP: POST to other nodes
        // self.broadcast_request(request_json).await?;
        info!(
            "Would broadcast request {} to other nodes: {}",
            request_id, request_json
        );

        // Wait for responses with proper timeout handling
        let timeout_duration = Duration::from_millis(self.requests_timeout);
        let max_expected_responses = expected_node_count.saturating_sub(1);

        // Improved waiting logic - check less frequently for better performance
        let check_interval = Duration::from_millis(50); // Check every 50ms instead of 10ms
        let mut checks = 0;
        let max_checks = (timeout_duration.as_millis() / check_interval.as_millis()) as usize;

        let responses = loop {
            if checks >= max_checks {
                // Timeout reached
                let current_responses = self.pending_requests
                    .get(&request_id)
                    .map(|r| r.responses.len())
                    .unwrap_or(0);

                warn!(
                    "Request {} timed out after {}ms, got {} responses out of {} expected",
                    request_id,
                    start.elapsed().as_millis(),
                    current_responses,
                    max_expected_responses
                );
                break self.pending_requests
                    .remove(&request_id)
                    .map(|(_, req)| req.responses)
                    .unwrap_or_default();
            }

            // Check if we have enough responses
            if let Some(pending_request) = self.pending_requests.get(&request_id) {
                if pending_request.responses.len() >= max_expected_responses {
                    info!(
                        "Request {} completed successfully with {}/{} responses in {}ms",
                        request_id,
                        pending_request.responses.len(),
                        max_expected_responses,
                        start.elapsed().as_millis()
                    );
                    break self.pending_requests
                        .remove(&request_id)
                        .map(|(_, req)| req.responses)
                        .unwrap_or_default();
                }
            } else {
                // Request was removed (possibly by cleanup), this is an error
                return Err(Error::Other(format!(
                    "Request {} was removed unexpectedly (possibly by cleanup task)",
                    request_id
                )));
            }

            tokio::time::sleep(check_interval).await;
            checks += 1;
        };

        // Use the new aggregation method
        let combined_response = self.aggregate_responses(
            request_id.clone(),
            self.node_id.clone(),
            app_id.to_string(),
            &request_type,
            responses,
        );

        // Validate the aggregated response
        if let Err(e) = self.validate_aggregated_response(&combined_response, &request_type) {
            warn!("Response validation failed for request {}: {}", request_id, e);
        }

        // Track metrics
        if let Some(metrics_ref) = &self.metrics {
            let metrics = metrics_ref.lock().await;
            let duration_ms = start.elapsed().as_millis() as f64;

            metrics.track_horizontal_adapter_resolve_time(app_id, duration_ms);

            // Consider it resolved if we got any meaningful data
            let resolved = combined_response.sockets_count > 0
                || !combined_response.members.is_empty()
                || combined_response.exists
                || !combined_response.channels.is_empty()
                || combined_response.members_count > 0
                || !combined_response.channels_with_sockets_count.is_empty()
                || max_expected_responses == 0;

            metrics.track_horizontal_adapter_resolved_promises(app_id, resolved);
        }

        Ok(combined_response)
    }

    /// Get statistics about pending requests (useful for monitoring)
    pub fn get_pending_requests_stats(&self) -> (usize, u64, u64) {
        let now = Instant::now();
        let mut count = 0;
        let mut oldest_ms = 0u64;
        let mut newest_ms = 0u64;

        for entry in self.pending_requests.iter() {
            count += 1;
            let age_ms = now.duration_since(entry.start_time).as_millis() as u64;

            if oldest_ms == 0 || age_ms > oldest_ms {
                oldest_ms = age_ms;
            }
            if newest_ms == 0 || age_ms < newest_ms {
                newest_ms = age_ms;
            }
        }

        (count, oldest_ms, newest_ms)
    }

    /// Clear all pending requests (useful for testing or emergency cleanup)
    pub fn clear_pending_requests(&mut self) -> usize {
        let count = self.pending_requests.len();
        self.pending_requests.clear();
        warn!("Cleared {} pending requests", count);
        count
    }

    /// Get the node ID
    pub fn get_node_id(&self) -> &str {
        &self.node_id
    }

    /// Set the request timeout
    pub fn set_request_timeout(&mut self, timeout_ms: u64) {
        self.requests_timeout = timeout_ms;
        info!("Set request timeout to {}ms", timeout_ms);
    }

    /// Set metrics interface
    pub fn set_metrics(&mut self, metrics: Arc<Mutex<dyn MetricsInterface + Send + Sync>>) {
        self.metrics = Some(metrics);
    }
}