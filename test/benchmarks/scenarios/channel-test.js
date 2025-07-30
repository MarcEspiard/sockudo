import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import crypto from 'k6/crypto';

// Custom metrics for channel-specific testing
const channelSubscriptions = new Counter('channel_subscriptions_total');
const channelUnsubscriptions = new Counter('channel_unsubscriptions_total');
const subscriptionLatency = new Trend('channel_subscription_latency', true);
const presenceUpdates = new Counter('presence_updates_total');
const privateChannelAuth = new Counter('private_channel_auth_total');
const authFailures = new Counter('auth_failures_total');
const messagesByChannelType = new Counter('messages_by_channel_type');
const channelMessageLatency = new Trend('channel_message_latency', true);

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 25 },   // 25 VUs per channel type = 100 total
    { duration: '2m', target: 50 },    // 50 VUs per channel type = 200 total
    { duration: '3m', target: 50 },    // Maintain load
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    channel_subscription_latency: ['p(95)<500'],     // Subscription latency
    channel_message_latency: ['p(95)<100'],          // Message latency per channel type
    channel_subscriptions_total: ['count>1000'],     // Minimum subscriptions
    private_channel_auth_total: ['count>200'],        // Authentication tests
  },
};

const BASE_URL = __ENV.SOCKUDO_URL || 'ws://localhost:6001';
const APP_KEY = __ENV.APP_KEY || 'demo-app';
const APP_SECRET = __ENV.APP_SECRET || 'demo-secret'; // For auth testing

// Channel type distribution for testing
const CHANNEL_TYPES = {
  PUBLIC: 'public',
  PRIVATE: 'private', 
  PRESENCE: 'presence',
  ENCRYPTED: 'private-encrypted'
};

// Generate HMAC signature for private channel authentication
function generateAuthSignature(socketId, channel, appSecret) {
  const stringToSign = `${socketId}:${channel}`;
  const signature = crypto.hmac('sha256', stringToSign, appSecret, 'hex');
  return `${APP_KEY}:${signature}`;
}

// Generate presence channel data
function generatePresenceData(userId) {
  return JSON.stringify({
    user_id: userId,
    user_info: {
      name: `User ${userId}`,
      avatar: `https://example.com/avatar/${userId}.jpg`,
      status: 'online',
      joined_at: new Date().toISOString()
    }
  });
}

export default function () {
  const url = `${BASE_URL}/app/${APP_KEY}`;
  const vuId = __VU;
  const channelTypeIndex = (vuId - 1) % 4; // Distribute VUs across channel types
  const channelType = Object.values(CHANNEL_TYPES)[channelTypeIndex];
  
  let socketId = null;
  let testChannels = [];
  const messageTimestamps = new Map();

  const res = ws.connect(url, { tags: { channelType } }, function (socket) {
    socket.on('open', () => {
      console.log(`VU ${vuId} connected for ${channelType} channel testing`);
    });

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        // Handle connection established
        if (message.event === 'pusher:connection_established') {
          const connData = JSON.parse(message.data);
          socketId = connData.socket_id;
          
          // Start channel-specific testing based on type
          setTimeout(() => testChannelType(socket, channelType, socketId), 1000);
        }
        
        // Track subscription success
        if (message.event === 'pusher_internal:subscription_succeeded') {
          const subscribeTime = messageTimestamps.get(`subscribe_${message.channel}`);
          if (subscribeTime) {
            subscriptionLatency.add(Date.now() - subscribeTime);
            messageTimestamps.delete(`subscribe_${message.channel}`);
          }
          
          console.log(`Subscribed to ${message.channel}`);
          
          // Start sending messages after subscription
          setTimeout(() => startChannelMessaging(socket, message.channel, channelType), 500);
        }
        
        // Track subscription errors
        if (message.event === 'pusher:subscription_error') {
          authFailures.add(1);
          console.error(`Subscription failed for ${message.channel}:`, message.data);
        }
        
        // Handle presence events
        if (message.event === 'pusher_internal:member_added' || 
            message.event === 'pusher_internal:member_removed') {
          presenceUpdates.add(1);
        }
        
        // Track message latency for client events
        if (message.event && message.event.startsWith('client-')) {
          messagesByChannelType.add(1, { channel_type: channelType });
          
          if (message.data) {
            try {
              const msgData = JSON.parse(message.data);
              if (msgData.timestamp) {
                const latency = Date.now() - msgData.timestamp;
                channelMessageLatency.add(latency, { channel_type: channelType });
              }
            } catch (e) {
              // Ignore parsing errors for message data
            }
          }
        }
        
      } catch (e) {
        console.error('Message parse error:', e);
      }
    });

    socket.on('error', (e) => {
      console.error(`WebSocket error for ${channelType}:`, e);
    });

    // Keep connection alive for test duration
    socket.setTimeout(() => {
      socket.close();
    }, 340000); // ~5.5 minutes
  });

  check(res, {
    'Channel test connection established': (r) => r && r.status === 101,
  });
}

function testChannelType(socket, channelType, socketId) {
  const vuId = __VU;
  
  switch (channelType) {
    case CHANNEL_TYPES.PUBLIC:
      testPublicChannels(socket, vuId);
      break;
    case CHANNEL_TYPES.PRIVATE:
      testPrivateChannels(socket, socketId, vuId);
      break;
    case CHANNEL_TYPES.PRESENCE:
      testPresenceChannels(socket, socketId, vuId);
      break;
    case CHANNEL_TYPES.ENCRYPTED:
      testEncryptedChannels(socket, socketId, vuId);
      break;
  }
}

function testPublicChannels(socket, vuId) {
  const channels = [
    `public-lobby-${vuId % 10}`,      // Shared lobbies
    `public-announcements`,            // Broadcast channel
    `public-chat-room-${vuId % 5}`,   // Chat rooms
  ];
  
  channels.forEach((channel, index) => {
    setTimeout(() => {
      subscribeToChannel(socket, channel);
    }, index * 1000);
  });
}

function testPrivateChannels(socket, socketId, vuId) {
  const channels = [
    `private-user-${vuId}`,           // Personal channel
    `private-group-${vuId % 10}`,     // Group channels
    `private-notifications-${vuId}`,   // Notification channel
  ];
  
  channels.forEach((channel, index) => {
    setTimeout(() => {
      subscribeToPrivateChannel(socket, channel, socketId);
    }, index * 1500);
  });
}

function testPresenceChannels(socket, socketId, vuId) {
  const channels = [
    `presence-room-${vuId % 5}`,      // Shared presence rooms
    `presence-game-${vuId % 3}`,      // Game lobbies
  ];
  
  channels.forEach((channel, index) => {
    setTimeout(() => {
      subscribeToPresenceChannel(socket, channel, socketId, vuId);
    }, index * 2000);
  });
}

function testEncryptedChannels(socket, socketId, vuId) {
  const channels = [
    `private-encrypted-secure-${vuId}`,     // Personal encrypted
    `private-encrypted-team-${vuId % 5}`,   // Team encrypted
  ];
  
  channels.forEach((channel, index) => {
    setTimeout(() => {
      subscribeToPrivateChannel(socket, channel, socketId); // Same auth as private
    }, index * 2000);
  });
}

function subscribeToChannel(socket, channel) {
  const timestamp = Date.now();
  messageTimestamps.set(`subscribe_${channel}`, timestamp);
  
  socket.send(JSON.stringify({
    event: 'pusher:subscribe',
    data: { channel }
  }));
  
  channelSubscriptions.add(1);
}

function subscribeToPrivateChannel(socket, channel, socketId) {
  const timestamp = Date.now();
  messageTimestamps.set(`subscribe_${channel}`, timestamp);
  
  const auth = generateAuthSignature(socketId, channel, APP_SECRET);
  
  socket.send(JSON.stringify({
    event: 'pusher:subscribe',
    data: {
      channel,
      auth
    }
  }));
  
  channelSubscriptions.add(1);
  privateChannelAuth.add(1);
}

function subscribeToPresenceChannel(socket, channel, socketId, userId) {
  const timestamp = Date.now();
  messageTimestamps.set(`subscribe_${channel}`, timestamp);
  
  const auth = generateAuthSignature(socketId, channel, APP_SECRET);
  const channelData = generatePresenceData(userId);
  
  socket.send(JSON.stringify({
    event: 'pusher:subscribe',
    data: {
      channel,
      auth,
      channel_data: channelData
    }
  }));
  
  channelSubscriptions.add(1);
  privateChannelAuth.add(1);
}

function startChannelMessaging(socket, channel, channelType) {
  // Send messages periodically
  const messageInterval = setInterval(() => {
    if (!socket || socket.readyState !== 1) {
      clearInterval(messageInterval);
      return;
    }
    
    const messageData = {
      timestamp: Date.now(),
      sender: __VU,
      channelType,
      payload: generateMessagePayload(channelType),
      messageId: `${__VU}-${Date.now()}-${Math.random()}`
    };
    
    const eventName = getEventNameForChannelType(channelType);
    
    socket.send(JSON.stringify({
      event: eventName,
      channel,
      data: JSON.stringify(messageData)
    }));
    
  }, 2000 + Math.random() * 3000); // 2-5 second intervals

  // Stop messaging after 4 minutes
  setTimeout(() => {
    clearInterval(messageInterval);
    
    // Test unsubscription
    setTimeout(() => {
      socket.send(JSON.stringify({
        event: 'pusher:unsubscribe',
        data: { channel }
      }));
      channelUnsubscriptions.add(1);
    }, 1000);
    
  }, 240000);
}

function generateMessagePayload(channelType) {
  const basePayload = {
    type: 'test_message',
    size: 'medium'
  };
  
  switch (channelType) {
    case CHANNEL_TYPES.PUBLIC:
      return {
        ...basePayload,
        content: 'Public announcement or chat message',
        visibility: 'public'
      };
      
    case CHANNEL_TYPES.PRIVATE:
      return {
        ...basePayload,
        content: 'Private message content',
        sensitive: true
      };
      
    case CHANNEL_TYPES.PRESENCE:
      return {
        ...basePayload,
        content: 'Message in presence room',
        userAction: 'typing',
        showPresence: true
      };
      
    case CHANNEL_TYPES.ENCRYPTED:
      return {
        ...basePayload,
        content: 'Encrypted message payload',
        encrypted: true,
        algorithm: 'AES-256'
      };
      
    default:
      return basePayload;
  }
}

function getEventNameForChannelType(channelType) {
  switch (channelType) {
    case CHANNEL_TYPES.PUBLIC:
      return 'client-message';
    case CHANNEL_TYPES.PRIVATE:
      return 'client-private-message';
    case CHANNEL_TYPES.PRESENCE:
      return 'client-presence-update';
    case CHANNEL_TYPES.ENCRYPTED:
      return 'client-encrypted-message';
    default:
      return 'client-test';
  }
}

// Generate comprehensive channel testing report
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
  
  const authAttempts = getMetricValue('private_channel_auth_total', 'value');
  const authFailures = getMetricValue('auth_failures_total', 'value');
  
  const channelMetrics = {
    timestamp: now,
    testConfiguration: {
      maxVUs: getMetricValue('vus', 'max'),
      testDuration: data.state?.testRunDurationMs || 0,
      channelTypes: Object.values(CHANNEL_TYPES),
    },
    subscriptions: {
      total: getMetricValue('channel_subscriptions_total', 'value'),
      unsubscriptions: getMetricValue('channel_unsubscriptions_total', 'value'),
      latency: {
        avg: getMetricValue('channel_subscription_latency', 'avg'),
        p95: getMetricValue('channel_subscription_latency', 'p(95)'),
        p99: getMetricValue('channel_subscription_latency', 'p(99)'),
      }
    },
    authentication: {
      attempts: authAttempts,
      failures: authFailures,
      successRate: authAttempts > 0 ? 1 - (authFailures / authAttempts) : 0,
    },
    messaging: {
      totalMessages: getMetricValue('messages_by_channel_type', 'value'),
      messageLatency: {
        avg: getMetricValue('channel_message_latency', 'avg'),
        p95: getMetricValue('channel_message_latency', 'p(95)'),
        p99: getMetricValue('channel_message_latency', 'p(99)'),
      }
    },
    presence: {
      updates: getMetricValue('presence_updates_total', 'value'),
    },
    performance: {
      iterations: getMetricValue('iterations', 'count'),
      dataTransferred: {
        sent: getMetricValue('data_sent', 'value'),
        received: getMetricValue('data_received', 'value'),
      }
    }
  };

  // Calculate channel type specific metrics if available
  if (data.metrics.messages_by_channel_type && data.metrics.messages_by_channel_type.values) {
    channelMetrics.channelTypeBreakdown = {};
    // Note: K6 doesn't easily expose tag-specific metrics in summary,
    // but this structure is ready for when that data is available
  }

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    '../results/channel-test-results.json': JSON.stringify(channelMetrics, null, 2),
  };
}