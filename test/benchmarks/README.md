# Sockudo Load Testing Suite

This directory contains comprehensive load testing tools for Sockudo, including connection tests, throughput measurements, and system metrics collection.

## Quick Start

```bash
# Start the benchmark environment
docker-compose -f docker-compose.benchmark.yml up -d

# Run connection load test
npm run test:connections

# Run throughput test
npm run test:throughput

# Run all tests
npm run test:all

# View results
ls results/
```

## Test Scenarios

### 1. Connection Test (`scenarios/connection-test.js`)

Tests connection establishment, WebSocket protocol handling, and connection limits.

**Metrics tracked:**
- Connection time (p95, p99)
- Connection success rate
- Active connections
- Messages sent/received
- WebSocket errors

**Configuration:**
```bash
SOCKUDO_URL=ws://localhost:6001 \
APP_KEY=demo-app \
k6 run scenarios/connection-test.js
```

### 2. Throughput Test (`scenarios/throughput-test.js`)

Measures message throughput, latency, and broadcast performance.

**Metrics tracked:**
- Messages per second
- Message latency (p95, p99)
- Broadcast latency
- Message delivery rate
- Bandwidth usage

**Configuration:**
```bash
SOCKUDO_URL=ws://localhost:6001 \
APP_KEY=demo-app \
MESSAGE_RATE=10 \
MESSAGE_SIZE=256 \
k6 run scenarios/throughput-test.js
```

### 3. System Metrics Collection

Real-time system monitoring during load tests.

**Metrics collected:**
- CPU usage (system and process)
- Memory usage (system and process)
- Network I/O
- Disk usage
- Docker container metrics
- Sockudo-specific metrics from Prometheus

**Usage:**
```bash
# Start metrics collection in background
npm run metrics:start &

# Run your load tests
npm run test:all

# Stop metrics collection (Ctrl+C)
# Results saved to results/system-metrics-*.json
```

## Docker Environment

Use `docker-compose.benchmark.yml` for isolated testing:

```bash
# Basic setup (Sockudo + Redis + K6)
docker-compose -f docker-compose.benchmark.yml up -d

# With monitoring (adds Prometheus + Grafana)
docker-compose -f docker-compose.benchmark.yml --profile monitoring up -d

# With scaling (multiple Sockudo instances)
docker-compose -f docker-compose.benchmark.yml --profile scaling up -d

# Run tests in Docker
docker-compose -f docker-compose.benchmark.yml --profile test run k6 run /scripts/scenarios/connection-test.js
```

## Test Profiles

### Connection Test Profile
- **Duration:** 7.5 minutes
- **Max VUs:** 1000
- **Ramp pattern:** Gradual increase to 1000, hold, then decrease
- **Channels:** Public benchmark channel
- **Focus:** Connection stability and limits

### Throughput Test Profile
- **Duration:** 4.5 minutes
- **Max VUs:** 100
- **Message rate:** 10 msg/sec per connection (configurable)
- **Message size:** 256 bytes (configurable)
- **Focus:** Message processing performance

## Results Analysis

### Output Files

All results are saved to the `results/` directory:

- `connection-test-results.json` - Connection test metrics
- `throughput-test-results.json` - Throughput test metrics
- `system-metrics-*.json` - System resource usage

### Key Performance Indicators

**Connection Performance:**
- Connection success rate > 95%
- Connection time p95 < 1000ms
- Messages received > 10,000

**Throughput Performance:**
- Messages per second > 1000
- Message latency p95 < 100ms
- Broadcast latency p95 < 200ms

**System Performance:**
- CPU usage < 80% under load
- Memory usage stable (no leaks)
- Network throughput consistent

## Monitoring and Visualization

### Prometheus Metrics

Access Prometheus at http://localhost:9090 when using monitoring profile.

Key metrics to monitor:
- `sockudo_active_connections`
- `sockudo_messages_total`
- `sockudo_active_channels`
- `sockudo_subscriptions_total`

### Grafana Dashboards

Access Grafana at http://localhost:3000 (admin/admin) for visual dashboards.

Dashboards include:
- Connection metrics over time
- Message throughput graphs
- System resource usage
- Error rates and latency percentiles

## Customization

### Environment Variables

- `SOCKUDO_URL` - WebSocket server URL (default: ws://localhost:6001)
- `APP_KEY` - Application key (default: demo-app)
- `MESSAGE_RATE` - Messages per second per connection (default: 10)
- `MESSAGE_SIZE` - Message payload size in bytes (default: 256)

### Custom Test Scenarios

Create new test files in `scenarios/` directory following the existing patterns:

```javascript
import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';

const customMetric = new Counter('my_custom_metric');

export const options = {
  stages: [
    { duration: '1m', target: 100 },
  ],
};

export default function () {
  // Your test logic here
}
```

## Performance Baselines

Use these as reference points for performance regressions:

### Baseline System (2 CPU, 4GB RAM)

**Connection Test:**
- Max connections: 1000
- Connection time p95: < 500ms
- Success rate: > 98%

**Throughput Test:**
- Messages/sec: > 2000
- Message latency p95: < 50ms
- CPU usage: < 60%

### High-Performance System (8 CPU, 16GB RAM)

**Connection Test:**
- Max connections: 5000
- Connection time p95: < 200ms
- Success rate: > 99%

**Throughput Test:**
- Messages/sec: > 10000
- Message latency p95: < 20ms
- CPU usage: < 40%

## Troubleshooting

### Common Issues

1. **Connection refused errors**
   - Ensure Sockudo is running and healthy
   - Check port mapping in docker-compose

2. **High memory usage in tests**
   - Reduce MESSAGE_RATE or test duration
   - Monitor for memory leaks in results

3. **Network timeouts**
   - Increase timeout values in test options
   - Check Docker network configuration

### Performance Debugging

1. **Enable detailed logging:**
   ```bash
   RUST_LOG=debug docker-compose -f docker-compose.benchmark.yml up sockudo
   ```

2. **Monitor system resources:**
   ```bash
   docker stats
   ```

3. **Check Sockudo metrics:**
   ```bash
   curl http://localhost:9601/metrics
   ```