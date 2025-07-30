import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Custom metrics
const connectionTime = new Trend('ws_connection_time', true);
const messagesReceived = new Counter('ws_messages_received');
const messagesSent = new Counter('ws_messages_sent');
const connectionErrors = new Counter('ws_connection_errors');
const activeConnections = new Gauge('ws_active_connections');
const connectionSuccess = new Rate('ws_connection_success');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 100 },   // Ramp up to 100 connections
    { duration: '1m', target: 500 },    // Ramp up to 500 connections
    { duration: '2m', target: 1000 },   // Ramp up to 1000 connections
    { duration: '3m', target: 1000 },   // Stay at 1000 connections
    { duration: '1m', target: 500 },    // Ramp down to 500
    { duration: '30s', target: 0 },     // Ramp down to 0
  ],
  thresholds: {
    ws_connection_time: ['p(95)<1000'],  // 95% of connections should complete in under 1s
    ws_connection_success: ['rate>0.95'], // 95% of connections should succeed
    ws_messages_received: ['count>10000'], // Should receive at least 10k messages
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const BASE_URL = __ENV.SOCKUDO_URL || 'ws://localhost:6001';
const APP_KEY = __ENV.APP_KEY || 'demo-app';

export default function () {
  const url = `${BASE_URL}/app/${APP_KEY}`;
  const params = {
    tags: { name: 'ConnectionTest' },
  };

  const startTime = new Date().getTime();
  
  const res = ws.connect(url, params, function (socket) {
    const connectTime = new Date().getTime() - startTime;
    connectionTime.add(connectTime);
    
    socket.on('open', () => {
      activeConnections.add(1);
      connectionSuccess.add(1);
      
      // Send initial ping
      socket.send(JSON.stringify({
        event: 'pusher:ping',
        data: {}
      }));
      messagesSent.add(1);
    });

    socket.on('message', (data) => {
      messagesReceived.add(1);
      
      try {
        const message = JSON.parse(data);
        
        // Handle connection established
        if (message.event === 'pusher:connection_established') {
          const connData = JSON.parse(message.data);
          socket.socketId = connData.socket_id;
          
          // Subscribe to a public channel
          socket.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: {
              channel: 'public-benchmark'
            }
          }));
          messagesSent.add(1);
        }
        
        // Handle subscription success
        if (message.event === 'pusher_internal:subscription_succeeded') {
          // Send a test message
          socket.send(JSON.stringify({
            event: 'client-test',
            channel: 'public-benchmark',
            data: JSON.stringify({
              timestamp: new Date().toISOString(),
              socketId: socket.socketId
            })
          }));
          messagesSent.add(1);
        }
        
        // Handle pong
        if (message.event === 'pusher:pong') {
          // Schedule next ping after 30s
          socket.setTimeout(() => {
            socket.send(JSON.stringify({
              event: 'pusher:ping',
              data: {}
            }));
            messagesSent.add(1);
          }, 30000);
        }
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    socket.on('close', () => {
      activeConnections.add(-1);
    });

    socket.on('error', (e) => {
      connectionErrors.add(1);
      connectionSuccess.add(0);
      console.error('WebSocket error:', e);
    });

    // Keep connection open for duration
    socket.setTimeout(() => {
      socket.close();
    }, 60000 + Math.random() * 30000); // 60-90 seconds
  });

  check(res, {
    'Connection established successfully': (r) => r && r.status === 101,
  });
}

// Custom summary with detailed metrics
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
  
  // Save detailed metrics to file
  const detailedMetrics = {
    timestamp: now,
    duration: data.state?.testRunDurationMs || 0,
    vus: {
      max: getMetricValue('vus', 'max'),
      min: getMetricValue('vus', 'min'),
    },
    connections: {
      total: getMetricValue('ws_connection_success', 'count'),
      successful: getMetricValue('ws_connection_success', 'passes'),
      failed: getMetricValue('ws_connection_errors', 'value'),
      successRate: getMetricValue('ws_connection_success', 'rate'),
      connectionTime: {
        avg: getMetricValue('ws_connection_time', 'avg'),
        p95: getMetricValue('ws_connection_time', 'p(95)'),
        p99: getMetricValue('ws_connection_time', 'p(99)'),
      }
    },
    messages: {
      sent: getMetricValue('ws_messages_sent', 'value'),
      received: getMetricValue('ws_messages_received', 'value'),
      perSecond: {
        sent: getMetricValue('ws_messages_sent', 'rate'),
        received: getMetricValue('ws_messages_received', 'rate'),
      }
    },
    system: {
      iterations: getMetricValue('iterations', 'count'),
      dataReceived: getMetricValue('data_received', 'value'),
      dataSent: getMetricValue('data_sent', 'value'),
    }
  };

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    '../results/connection-test-results.json': JSON.stringify(detailedMetrics, null, 2),
  };
}