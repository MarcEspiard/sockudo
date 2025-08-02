import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Custom metrics for throughput testing
const messageLatency = new Trend('ws_message_latency', true);
const messagesPerSecond = new Gauge('ws_messages_per_second');
const messagesSentCounter = new Counter('ws_messages_sent_total');
const messagesReceivedCounter = new Counter('ws_messages_received_total');
const messageErrors = new Counter('ws_message_errors');
const messageSizeBytes = new Trend('ws_message_size_bytes');
const broadcastLatency = new Trend('ws_broadcast_latency', true);

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 50 },    // Warm up with 50 VUs
    { duration: '1m', target: 100 },    // Ramp to 100 VUs
    { duration: '3m', target: 100 },    // Maintain 100 VUs for throughput test
    { duration: '30s', target: 0 },     // Ramp down
  ],
  thresholds: {
    ws_message_latency: ['p(95)<100', 'p(99)<200'],  // Message latency thresholds
    ws_messages_per_second: ['value>1000'],           // Minimum 1000 msg/sec
    ws_broadcast_latency: ['p(95)<200'],              // Broadcast latency
  },
};

const BASE_URL = __ENV.SOCKUDO_URL || 'ws://localhost:6001';
const APP_KEY = __ENV.APP_KEY || 'demo-app';
const MESSAGE_RATE = parseInt(__ENV.MESSAGE_RATE) || 10; // Messages per second per connection
const MESSAGE_SIZE = parseInt(__ENV.MESSAGE_SIZE) || 256; // Message payload size in bytes

// Generate random payload of specified size
function generatePayload(size) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < size; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default function () {
  const url = `${BASE_URL}/app/${APP_KEY}`;
  const params = { tags: { name: 'ThroughputTest' } };
  
  let socketId = null;
  let messageCount = 0;
  let lastMessageCount = 0;
  let lastCheck = Date.now();
  const sentMessages = new Map(); // Track sent messages for latency

  const res = ws.connect(url, params, function (socket) {
    socket.on('open', () => {
      console.log(`VU ${__VU} connected`);
    });

    socket.on('message', (data) => {
      messagesReceivedCounter.add(1);
      messageCount++;
      
      try {
        const message = JSON.parse(data);
        messageSizeBytes.add(data.length);
        
        // Handle connection established
        if (message.event === 'pusher:connection_established') {
          const connData = JSON.parse(message.data);
          socketId = connData.socket_id;
          
          // Subscribe to test channels
          socket.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { channel: 'public-throughput-test' }
          }));
          
          socket.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { channel: `private-throughput-${__VU}` }
          }));
          messagesSentCounter.add(2);
        }
        
        // Handle subscription success
        if (message.event === 'pusher_internal:subscription_succeeded') {
          if (message.channel === 'public-throughput-test') {
            // Start sending messages at specified rate
            startMessageLoop(socket, socketId);
          }
        }
        
        // Track message latency
        if (message.event === 'client-echo' && message.data) {
          const msgData = JSON.parse(message.data);
          const sentTime = sentMessages.get(msgData.id);
          if (sentTime) {
            const latency = Date.now() - sentTime;
            messageLatency.add(latency);
            sentMessages.delete(msgData.id);
          }
        }
        
        // Track broadcast latency
        if (message.event === 'client-broadcast' && message.data) {
          const msgData = JSON.parse(message.data);
          if (msgData.timestamp) {
            const latency = Date.now() - msgData.timestamp;
            broadcastLatency.add(latency);
          }
        }
        
      } catch (e) {
        messageErrors.add(1);
        console.error('Message parse error:', e);
      }
    });

    socket.on('error', (e) => {
      console.error('WebSocket error:', e);
    });

    // Calculate messages per second every second
    socket.setInterval(() => {
      const now = Date.now();
      const timeDiff = (now - lastCheck) / 1000; // seconds
      const msgDiff = messageCount - lastMessageCount;
      const currentRate = msgDiff / timeDiff;
      
      messagesPerSecond.add(currentRate);
      
      lastMessageCount = messageCount;
      lastCheck = now;
    }, 1000);

    // Keep connection open for test duration
    socket.setTimeout(() => {
      socket.close();
    }, 240000); // 4 minutes
  });

  check(res, {
    'Connection established': (r) => r && r.status === 101,
  });
}

function startMessageLoop(socket, socketId) {
  const interval = 1000 / MESSAGE_RATE; // milliseconds between messages
  
  socket.setInterval(() => {
    const messageId = `${socketId}-${Date.now()}-${Math.random()}`;
    const timestamp = Date.now();
    
    // Send point-to-point message (echo test)
    const echoMessage = {
      event: 'client-echo',
      channel: `private-throughput-${__VU}`,
      data: JSON.stringify({
        id: messageId,
        timestamp: timestamp,
        payload: generatePayload(MESSAGE_SIZE),
        vu: __VU
      })
    };
    
    sentMessages.set(messageId, timestamp);
    socket.send(JSON.stringify(echoMessage));
    messagesSentCounter.add(1);
    
    // Send broadcast message every 10th message
    if (Math.random() < 0.1) {
      const broadcastMessage = {
        event: 'client-broadcast',
        channel: 'public-throughput-test',
        data: JSON.stringify({
          timestamp: timestamp,
          payload: generatePayload(MESSAGE_SIZE / 2),
          source: socketId
        })
      };
      
      socket.send(JSON.stringify(broadcastMessage));
      messagesSentCounter.add(1);
    }
    
    // Clean up old sent messages to prevent memory leak
    if (sentMessages.size > 1000) {
      const cutoff = Date.now() - 10000; // 10 seconds
      for (const [id, time] of sentMessages) {
        if (time < cutoff) {
          sentMessages.delete(id);
        }
      }
    }
  }, interval);
}

// Generate detailed report
export function handleSummary(data) {
  const now = new Date().toISOString();
  
  // Helper function to safely get metric values
  const getMetricValue = (metricPath, property, defaultValue = 0) => {
    try {
      const metric = metricPath.split('.').reduce((obj, key) => obj?.[key], data.metrics);
      return metric?.values?.[property] ?? defaultValue;
    } catch (e) {
      return defaultValue;
    }
  };
  
  const totalMessagesSent = getMetricValue('ws_messages_sent_total', 'value');
  const totalMessagesReceived = getMetricValue('ws_messages_received_total', 'value');
  const testDurationSeconds = (data.state?.testRunDurationMs || 1000) / 1000;
  
  const detailedMetrics = {
    timestamp: now,
    configuration: {
      messageRate: MESSAGE_RATE,
      messageSize: MESSAGE_SIZE,
      maxVUs: getMetricValue('vus', 'max'),
    },
    throughput: {
      totalMessagesSent: totalMessagesSent,
      totalMessagesReceived: totalMessagesReceived,
      avgMessagesPerSecond: totalMessagesSent / testDurationSeconds,
      peakMessagesPerSecond: getMetricValue('ws_messages_per_second', 'max'),
      messageDeliveryRate: totalMessagesSent > 0 ? totalMessagesReceived / totalMessagesSent : 0,
    },
    latency: {
      message: {
        avg: getMetricValue('ws_message_latency', 'avg'),
        median: getMetricValue('ws_message_latency', 'med'),
        p95: getMetricValue('ws_message_latency', 'p(95)'),
        p99: getMetricValue('ws_message_latency', 'p(99)'),
        max: getMetricValue('ws_message_latency', 'max'),
      },
      broadcast: {
        avg: getMetricValue('ws_broadcast_latency', 'avg'),
        p95: getMetricValue('ws_broadcast_latency', 'p(95)'),
        p99: getMetricValue('ws_broadcast_latency', 'p(99)'),
      }
    },
    bandwidth: {
      totalDataSent: getMetricValue('data_sent', 'value'),
      totalDataReceived: getMetricValue('data_received', 'value'),
      avgMessageSize: getMetricValue('ws_message_size_bytes', 'avg'),
    },
    errors: {
      messageErrors: getMetricValue('ws_message_errors', 'value'),
      errorRate: totalMessagesReceived > 0 ? getMetricValue('ws_message_errors', 'value') / totalMessagesReceived : 0,
    }
  };

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    './results/throughput-test-results.json': JSON.stringify(detailedMetrics, null, 2),
  };
}