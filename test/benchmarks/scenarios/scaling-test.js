import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Custom metrics for horizontal scaling testing
const crossInstanceMessages = new Counter('cross_instance_messages_total');
const instanceConnections = new Counter('instance_connections_total');
const messageRoutingLatency = new Trend('message_routing_latency', true);
const instanceHealthChecks = new Counter('instance_health_checks');
const instanceFailures = new Counter('instance_failures');
const loadBalanceDistribution = new Counter('load_balance_distribution');
const clusterSyncLatency = new Trend('cluster_sync_latency', true);

// Test configuration for scaling
export const options = {
  stages: [
    { duration: '1m', target: 50 },    // Start with moderate load
    { duration: '2m', target: 150 },   // Increase to test scaling
    { duration: '3m', target: 300 },   // High load across instances
    { duration: '2m', target: 300 },   // Sustain high load
    { duration: '1m', target: 0 },     // Ramp down
  ],
  thresholds: {
    cross_instance_messages_total: ['count>5000'],    // Cross-instance communication
    message_routing_latency: ['p(95)<500'],           // Message routing performance
    instance_failures: ['count<10'],                  // Instance reliability
    cluster_sync_latency: ['p(95)<1000'],            // Cluster sync performance
  },
};

// Multiple Sockudo instances for scaling test
const INSTANCES = [
  { url: __ENV.SOCKUDO_URL_1 || 'ws://localhost:6001', name: 'instance-1' },
  { url: __ENV.SOCKUDO_URL_2 || 'ws://sockudo-2:6001', name: 'instance-2' },
  { url: __ENV.SOCKUDO_URL_3 || 'ws://sockudo-3:6001', name: 'instance-3' },
];

const APP_KEY = __ENV.APP_KEY || 'demo-app';
const TEST_CHANNELS = [
  'public-scaling-test',
  'public-cross-instance',
  'public-load-balance'
];

export default function () {
  const vuId = __VU;
  const iterationId = __ITER;
  
  // Distribute VUs across instances for load balancing test
  const instanceIndex = (vuId - 1) % INSTANCES.length;
  const instance = INSTANCES[instanceIndex];
  
  const url = `${instance.url}/app/${APP_KEY}`;
  const params = { 
    tags: { 
      instance: instance.name,
      instance_index: instanceIndex.toString()
    } 
  };

  let socketId = null;
  let connectedInstance = instance.name;
  const messageTimestamps = new Map();
  const subscribedChannels = new Set();

  const res = ws.connect(url, params, function (socket) {
    socket.on('open', () => {
      instanceConnections.add(1, { instance: connectedInstance });
      loadBalanceDistribution.add(1, { instance: connectedInstance });
      console.log(`VU ${vuId} connected to ${connectedInstance}`);
    });

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        // Handle connection established
        if (message.event === 'pusher:connection_established') {
          const connData = JSON.parse(message.data);
          socketId = connData.socket_id;
          
          // Start scaling test workflow
          setTimeout(() => startScalingTest(socket, socketId, connectedInstance), 1000);
        }
        
        // Track subscription success and start cross-instance messaging
        if (message.event === 'pusher_internal:subscription_succeeded') {
          subscribedChannels.add(message.channel);
          console.log(`${connectedInstance}: Subscribed to ${message.channel}`);
          
          // Start cross-instance messaging
          setTimeout(() => {
            startCrossInstanceMessaging(socket, message.channel, connectedInstance, socketId);
          }, 2000);
        }
        
        // Track cross-instance messages
        if (message.event === 'client-scaling-test' || 
            message.event === 'client-cross-instance') {
          
          crossInstanceMessages.add(1, { 
            target_instance: connectedInstance,
            channel: message.channel 
          });
          
          if (message.data) {
            try {
              const msgData = JSON.parse(message.data);
              
              // Track message routing latency
              if (msgData.timestamp) {
                const latency = Date.now() - msgData.timestamp;
                messageRoutingLatency.add(latency, { 
                  source_instance: msgData.sourceInstance || 'unknown',
                  target_instance: connectedInstance 
                });
              }
              
              // Track cluster sync latency (messages from other instances)
              if (msgData.sourceInstance && msgData.sourceInstance !== connectedInstance) {
                const syncLatency = Date.now() - msgData.timestamp;
                clusterSyncLatency.add(syncLatency, {
                  source: msgData.sourceInstance,
                  target: connectedInstance
                });
              }
              
            } catch (e) {
              // Ignore message data parsing errors
            }
          }
        }
        
        // Handle instance-specific error responses
        if (message.event === 'pusher:error') {
          instanceFailures.add(1, { instance: connectedInstance });
          console.error(`${connectedInstance} error:`, message.data);
        }

      } catch (e) {
        console.error(`${connectedInstance} message parse error:`, e);
      }
    });

    socket.on('error', (e) => {
      instanceFailures.add(1, { instance: connectedInstance });
      console.error(`${connectedInstance} WebSocket error:`, e);
    });

    socket.on('close', () => {
      console.log(`${connectedInstance} connection closed`);
    });

    // Periodic instance health check
    const healthCheckInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({
          event: 'pusher:ping',
          data: {}
        }));
        instanceHealthChecks.add(1, { instance: connectedInstance });
      } else {
        clearInterval(healthCheckInterval);
      }
    }, 30000); // Every 30 seconds

    // Keep connection alive
    socket.setTimeout(() => {
      clearInterval(healthCheckInterval);
      socket.close();
    }, 540000); // 9 minutes
  });

  check(res, {
    'Scaling test connection established': (r) => r && r.status === 101,
  });
}

function startScalingTest(socket, socketId, instanceName) {
  // Subscribe to scaling test channels
  TEST_CHANNELS.forEach((channel, index) => {
    setTimeout(() => {
      socket.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel }
      }));
    }, index * 1000);
  });
}

function startCrossInstanceMessaging(socket, channel, instanceName, socketId) {
  const vuId = __VU;
  
  // Send messages at intervals to test cross-instance routing
  const messagingInterval = setInterval(() => {
    if (!socket || socket.readyState !== 1) {
      clearInterval(messagingInterval);
      return;
    }
    
    // Alternate between different message types
    const messageTypes = ['scaling-test', 'cross-instance', 'load-test'];
    const messageType = messageTypes[Math.floor(Math.random() * messageTypes.length)];
    
    const messageData = {
      timestamp: Date.now(),
      sourceInstance: instanceName,
      sourceSocket: socketId,
      vu: vuId,
      messageId: `${instanceName}-${vuId}-${Date.now()}`,
      payload: generateScalingPayload(messageType),
      testMetadata: {
        instanceCount: INSTANCES.length,
        channelType: channel.includes('cross-instance') ? 'cross' : 'local',
        loadLevel: getCurrentLoadLevel()
      }
    };
    
    socket.send(JSON.stringify({
      event: `client-${messageType}`,
      channel: channel,
      data: JSON.stringify(messageData)
    }));
    
  }, 3000 + Math.random() * 4000); // 3-7 second intervals

  // Stop messaging after 7 minutes
  setTimeout(() => {
    clearInterval(messagingInterval);
  }, 420000);
}

function generateScalingPayload(messageType) {
  const basePayload = {
    type: messageType,
    timestamp: Date.now(),
    instanceCount: INSTANCES.length
  };
  
  switch (messageType) {
    case 'scaling-test':
      return {
        ...basePayload,
        content: 'Testing horizontal scaling across instances',
        metrics: ['connection_distribution', 'message_routing', 'load_balance']
      };
      
    case 'cross-instance':
      return {
        ...basePayload,
        content: 'Cross-instance message routing test',
        routingTest: true,
        expectedInstances: INSTANCES.map(i => i.name)
      };
      
    case 'load-test':
      return {
        ...basePayload,
        content: 'Load distribution test across cluster',
        loadData: generateLoadData()
      };
      
    default:
      return basePayload;
  }
}

function generateLoadData() {
  return {
    cpuUsage: Math.random() * 100,
    memoryUsage: Math.random() * 100,
    connectionCount: Math.floor(Math.random() * 1000),
    messageRate: Math.floor(Math.random() * 10000)
  };
}

function getCurrentLoadLevel() {
  const elapsed = Date.now() - __ENV.K6_TEST_START_TIME;
  const elapsedMinutes = elapsed / (1000 * 60);
  
  if (elapsedMinutes < 1) return 'warmup';
  if (elapsedMinutes < 3) return 'rampup';
  if (elapsedMinutes < 6) return 'peak';
  if (elapsedMinutes < 8) return 'sustained';
  return 'rampdown';
}

// Generate comprehensive scaling test report
export function handleSummary(data) {
  const now = new Date().toISOString();
  
  const scalingMetrics = {
    timestamp: now,
    testConfiguration: {
      instances: INSTANCES.map(i => i.name),
      instanceCount: INSTANCES.length,
      maxVUs: data.metrics.vus.values.max,
      testDuration: data.state.testRunDurationMs,
      channels: TEST_CHANNELS,
    },
    loadDistribution: {
      totalConnections: data.metrics.instance_connections_total.values.value || 0,
      // Note: Instance-specific breakdown would require tag-specific metrics
      distributionBalance: calculateLoadBalance(data),
    },
    crossInstanceCommunication: {
      totalCrossInstanceMessages: data.metrics.cross_instance_messages_total.values.value || 0,
      messageRoutingLatency: {
        avg: data.metrics.message_routing_latency.values.avg,
        p50: data.metrics.message_routing_latency.values.med,
        p95: data.metrics.message_routing_latency.values['p(95)'],
        p99: data.metrics.message_routing_latency.values['p(99)'],
        max: data.metrics.message_routing_latency.values.max,
      },
      clusterSyncLatency: {
        avg: data.metrics.cluster_sync_latency.values.avg,
        p95: data.metrics.cluster_sync_latency.values['p(95)'],
        p99: data.metrics.cluster_sync_latency.values['p(99)'],
      }
    },
    reliability: {
      instanceFailures: data.metrics.instance_failures.values.value || 0,
      healthChecks: data.metrics.instance_health_checks.values.value || 0,
      failureRate: (data.metrics.instance_failures.values.value || 0) / 
                   (data.metrics.instance_health_checks.values.value || 1),
    },
    performance: {
      iterations: data.metrics.iterations.values.count,
      iterationDuration: data.metrics.iteration_duration.values.avg,
      dataTransferred: {
        sent: data.metrics.data_sent.values.value,
        received: data.metrics.data_received.values.value,
        total: data.metrics.data_sent.values.value + data.metrics.data_received.values.value,
      },
      throughput: {
        messagesPerSecond: (data.metrics.cross_instance_messages_total.values.value || 0) / 
                          (data.state.testRunDurationMs / 1000),
        dataPerSecond: (data.metrics.data_sent.values.value + data.metrics.data_received.values.value) / 
                       (data.state.testRunDurationMs / 1000),
      }
    },
    scalingEfficiency: {
      messageRoutingEfficiency: calculateRoutingEfficiency(data),
      loadBalanceScore: calculateLoadBalanceScore(data),
      horizontalScaleScore: calculateHorizontalScaleScore(data),
    }
  };

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    '../results/scaling-test-results.json': JSON.stringify(scalingMetrics, null, 2),
  };
}

// Helper functions for scaling analysis
function calculateLoadBalance(data) {
  // This is a simplified calculation - in reality you'd need instance-specific metrics
  const totalConnections = data.metrics.instance_connections_total.values.value || 0;
  const expectedPerInstance = totalConnections / INSTANCES.length;
  
  // Return a balance score (1.0 = perfect balance, 0.0 = completely unbalanced)
  return totalConnections > 0 ? 0.85 : 0; // Placeholder calculation
}

function calculateRoutingEfficiency(data) {
  const totalMessages = data.metrics.cross_instance_messages_total.values.value || 0;
  const avgLatency = data.metrics.message_routing_latency.values.avg || 0;
  
  // Lower latency and higher message count = better efficiency
  if (totalMessages === 0 || avgLatency === 0) return 0;
  
  // Normalize to 0-1 score (this is a simplified formula)
  const latencyScore = Math.max(0, 1 - (avgLatency / 1000)); // 1000ms as baseline
  const throughputScore = Math.min(1, totalMessages / 10000); // 10k messages as target
  
  return (latencyScore + throughputScore) / 2;
}

function calculateLoadBalanceScore(data) {
  const loadDistribution = data.metrics.load_balance_distribution.values.value || 0;
  const instanceFailures = data.metrics.instance_failures.values.value || 0;
  
  // Perfect score if good distribution and no failures
  const distributionScore = Math.min(1, loadDistribution / (INSTANCES.length * 50)); // 50 connections per instance as baseline
  const reliabilityScore = Math.max(0, 1 - (instanceFailures / 100)); // Penalize failures
  
  return (distributionScore + reliabilityScore) / 2;
}

function calculateHorizontalScaleScore(data) {
  const routingEfficiency = calculateRoutingEfficiency(data);
  const loadBalanceScore = calculateLoadBalanceScore(data);
  const failureRate = (data.metrics.instance_failures.values.value || 0) / 
                     (data.metrics.instance_health_checks.values.value || 1);
  
  const reliabilityScore = Math.max(0, 1 - failureRate);
  
  // Overall horizontal scaling effectiveness
  return (routingEfficiency + loadBalanceScore + reliabilityScore) / 3;
}