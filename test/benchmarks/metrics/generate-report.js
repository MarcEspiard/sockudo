const fs = require('fs').promises;
const path = require('path');

class PerformanceReportGenerator {
  constructor(resultsDir) {
    this.resultsDir = resultsDir;
    this.results = {};
  }

  async generateReport() {
    await this.loadResults();
    return this.createMarkdownReport();
  }

  async loadResults() {
    try {
      const files = await fs.readdir(this.resultsDir);
      
      for (const file of files) {
        if (file.endsWith('-results.json')) {
          const filePath = path.join(this.resultsDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const testType = file.replace('-results.json', '').replace('-test', '');
          this.results[testType] = JSON.parse(content);
        }
      }
    } catch (error) {
      console.error('Error loading results:', error);
    }
  }

  createMarkdownReport() {
    let report = '';
    
    // Header
    report += this.createHeader();
    
    // Summary
    report += this.createSummary();
    
    // Detailed results for each test type
    if (this.results.connection) {
      report += this.createConnectionReport();
    }
    
    if (this.results.throughput) {
      report += this.createThroughputReport();
    }
    
    if (this.results.channel) {
      report += this.createChannelReport();
    }
    
    if (this.results.scaling) {
      report += this.createScalingReport();
    }
    
    // Performance comparison and recommendations
    report += this.createRecommendations();
    
    return report;
  }

  createHeader() {
    const timestamp = new Date().toISOString();
    return `# Performance Benchmark Report\n\n**Generated:** ${timestamp}\n\n`;
  }

  createSummary() {
    let summary = '## 📊 Executive Summary\n\n';
    
    const tests = Object.keys(this.results);
    if (tests.length === 0) {
      return summary + '❌ No test results found.\n\n';
    }
    
    summary += '| Test | Status | Key Metric | Result | Threshold |\n';
    summary += '|------|--------|------------|--------|-----------|\n';
    
    // Connection test summary
    if (this.results.connection) {
      const conn = this.results.connection;
      const status = conn.connections.successRate > 0.95 ? '✅' : '❌';
      summary += `| Connection | ${status} | Success Rate | ${(conn.connections.successRate * 100).toFixed(1)}% | >95% |\n`;
    }
    
    // Throughput test summary
    if (this.results.throughput) {
      const throughput = this.results.throughput;
      const msgPerSec = throughput.throughput?.avgMessagesPerSecond || 0;
      const status = msgPerSec > 1000 ? '✅' : '❌';
      summary += `| Throughput | ${status} | Messages/sec | ${msgPerSec.toFixed(0)} | >1000 |\n`;
    }
    
    // Channel test summary
    if (this.results.channel) {
      const channel = this.results.channel;
      const authRate = channel.authentication?.successRate || 0;
      const status = authRate > 0.95 ? '✅' : '❌';
      summary += `| Channel | ${status} | Auth Success | ${(authRate * 100).toFixed(1)}% | >95% |\n`;
    }
    
    // Scaling test summary
    if (this.results.scaling) {
      const scaling = this.results.scaling;
      const scaleScore = scaling.scalingEfficiency?.horizontalScaleScore || 0;
      const status = scaleScore > 0.8 ? '✅' : '❌';
      summary += `| Scaling | ${status} | Scale Score | ${(scaleScore * 100).toFixed(0)}% | >80% |\n`;
    }
    
    return summary + '\n';
  }

  createConnectionReport() {
    const conn = this.results.connection;
    let report = '## 🔌 Connection Test Results\n\n';
    
    // Connection metrics
    report += '### Connection Performance\n\n';
    report += `- **Total Connections:** ${conn.connections.total.toLocaleString()}\n`;
    report += `- **Successful:** ${conn.connections.successful.toLocaleString()} (${(conn.connections.successRate * 100).toFixed(2)}%)\n`;
    report += `- **Failed:** ${conn.connections.failed.toLocaleString()}\n`;
    report += `- **Connection Time (p95):** ${conn.connections.connectionTime.p95.toFixed(0)}ms\n`;
    report += `- **Connection Time (p99):** ${conn.connections.connectionTime.p99.toFixed(0)}ms\n\n`;
    
    // Message metrics
    report += '### Message Performance\n\n';
    report += `- **Messages Sent:** ${conn.messages.sent.toLocaleString()}\n`;
    report += `- **Messages Received:** ${conn.messages.received.toLocaleString()}\n`;
    report += `- **Send Rate:** ${conn.messages.perSecond.sent.toFixed(1)} msg/sec\n`;
    report += `- **Receive Rate:** ${conn.messages.perSecond.received.toFixed(1)} msg/sec\n\n`;
    
    // Performance indicators
    const connectionStatus = conn.connections.successRate > 0.95 ? '✅ Excellent' : 
                           conn.connections.successRate > 0.90 ? '⚠️ Good' : '❌ Poor';
    const latencyStatus = conn.connections.connectionTime.p95 < 500 ? '✅ Excellent' :
                         conn.connections.connectionTime.p95 < 1000 ? '⚠️ Good' : '❌ Poor';
    
    report += '### Assessment\n\n';
    report += `- **Connection Reliability:** ${connectionStatus}\n`;
    report += `- **Connection Latency:** ${latencyStatus}\n\n`;
    
    return report;
  }

  createThroughputReport() {
    const throughput = this.results.throughput;
    let report = '## ⚡ Throughput Test Results\n\n';
    
    // Throughput metrics
    report += '### Message Throughput\n\n';
    report += `- **Total Messages Sent:** ${throughput.throughput.totalMessagesSent.toLocaleString()}\n`;
    report += `- **Total Messages Received:** ${throughput.throughput.totalMessagesReceived.toLocaleString()}\n`;
    report += `- **Average Messages/sec:** ${throughput.throughput.avgMessagesPerSecond.toFixed(0)}\n`;
    report += `- **Peak Messages/sec:** ${throughput.throughput.peakMessagesPerSecond.toFixed(0)}\n`;
    report += `- **Delivery Rate:** ${(throughput.throughput.messageDeliveryRate * 100).toFixed(2)}%\n\n`;
    
    // Latency metrics
    report += '### Message Latency\n\n';
    report += `- **Average Latency:** ${throughput.latency.message.avg.toFixed(1)}ms\n`;
    report += `- **Median Latency:** ${throughput.latency.message.median.toFixed(1)}ms\n`;
    report += `- **95th Percentile:** ${throughput.latency.message.p95.toFixed(1)}ms\n`;
    report += `- **99th Percentile:** ${throughput.latency.message.p99.toFixed(1)}ms\n`;
    report += `- **Max Latency:** ${throughput.latency.message.max.toFixed(1)}ms\n\n`;
    
    // Broadcast performance
    if (throughput.latency.broadcast) {
      report += '### Broadcast Performance\n\n';
      report += `- **Average Broadcast Latency:** ${throughput.latency.broadcast.avg.toFixed(1)}ms\n`;
      report += `- **Broadcast p95:** ${throughput.latency.broadcast.p95.toFixed(1)}ms\n`;
      report += `- **Broadcast p99:** ${throughput.latency.broadcast.p99.toFixed(1)}ms\n\n`;
    }
    
    // Bandwidth usage
    report += '### Bandwidth Usage\n\n';
    report += `- **Data Sent:** ${this.formatBytes(throughput.bandwidth.totalDataSent)}\n`;
    report += `- **Data Received:** ${this.formatBytes(throughput.bandwidth.totalDataReceived)}\n`;
    report += `- **Average Message Size:** ${throughput.bandwidth.avgMessageSize.toFixed(0)} bytes\n\n`;
    
    // Performance assessment
    const throughputStatus = throughput.throughput.avgMessagesPerSecond > 2000 ? '✅ Excellent' :
                           throughput.throughput.avgMessagesPerSecond > 1000 ? '⚠️ Good' : '❌ Poor';
    const latencyStatus = throughput.latency.message.p95 < 50 ? '✅ Excellent' :
                         throughput.latency.message.p95 < 100 ? '⚠️ Good' : '❌ Poor';
    
    report += '### Assessment\n\n';
    report += `- **Message Throughput:** ${throughputStatus}\n`;
    report += `- **Message Latency:** ${latencyStatus}\n`;
    report += `- **Error Rate:** ${(throughput.errors?.errorRate * 100 || 0).toFixed(2)}%\n\n`;
    
    return report;
  }

  createChannelReport() {
    const channel = this.results.channel;
    let report = '## 📺 Channel Test Results\n\n';
    
    // Subscription metrics
    report += '### Channel Subscriptions\n\n';
    report += `- **Total Subscriptions:** ${channel.subscriptions.total.toLocaleString()}\n`;
    report += `- **Total Unsubscriptions:** ${channel.subscriptions.unsubscriptions.toLocaleString()}\n`;
    report += `- **Subscription Latency (avg):** ${channel.subscriptions.latency.avg.toFixed(1)}ms\n`;
    report += `- **Subscription Latency (p95):** ${channel.subscriptions.latency.p95.toFixed(1)}ms\n\n`;
    
    // Authentication metrics
    report += '### Channel Authentication\n\n';
    report += `- **Auth Attempts:** ${channel.authentication.attempts.toLocaleString()}\n`;
    report += `- **Auth Failures:** ${channel.authentication.failures.toLocaleString()}\n`;
    report += `- **Success Rate:** ${(channel.authentication.successRate * 100).toFixed(2)}%\n\n`;
    
    // Messaging performance
    report += '### Channel Messaging\n\n';
    report += `- **Total Messages:** ${channel.messaging.totalMessages.toLocaleString()}\n`;
    report += `- **Message Latency (avg):** ${channel.messaging.messageLatency.avg.toFixed(1)}ms\n`;
    report += `- **Message Latency (p95):** ${channel.messaging.messageLatency.p95.toFixed(1)}ms\n\n`;
    
    // Presence channel metrics
    if (channel.presence.updates > 0) {
      report += '### Presence Channels\n\n';
      report += `- **Presence Updates:** ${channel.presence.updates.toLocaleString()}\n\n`;
    }
    
    // Performance assessment
    const authStatus = channel.authentication.successRate > 0.98 ? '✅ Excellent' :
                      channel.authentication.successRate > 0.95 ? '⚠️ Good' : '❌ Poor';
    const subscriptionStatus = channel.subscriptions.latency.p95 < 200 ? '✅ Excellent' :
                              channel.subscriptions.latency.p95 < 500 ? '⚠️ Good' : '❌ Poor';
    
    report += '### Assessment\n\n';
    report += `- **Authentication:** ${authStatus}\n`;
    report += `- **Subscription Performance:** ${subscriptionStatus}\n\n`;
    
    return report;
  }

  createScalingReport() {
    const scaling = this.results.scaling;
    let report = '## 📈 Scaling Test Results\n\n';
    
    // Configuration
    report += '### Test Configuration\n\n';
    report += `- **Instances:** ${scaling.testConfiguration.instanceCount}\n`;
    report += `- **Max VUs:** ${scaling.testConfiguration.maxVUs.toLocaleString()}\n`;
    report += `- **Test Duration:** ${(scaling.testConfiguration.testDuration / 60000).toFixed(1)} minutes\n\n`;
    
    // Load distribution
    report += '### Load Distribution\n\n';
    report += `- **Total Connections:** ${scaling.loadDistribution.totalConnections.toLocaleString()}\n`;
    report += `- **Distribution Balance:** ${(scaling.loadDistribution.distributionBalance * 100).toFixed(1)}%\n\n`;
    
    // Cross-instance communication
    report += '### Cross-Instance Communication\n\n';
    report += `- **Cross-Instance Messages:** ${scaling.crossInstanceCommunication.totalCrossInstanceMessages.toLocaleString()}\n`;
    report += `- **Routing Latency (avg):** ${scaling.crossInstanceCommunication.messageRoutingLatency.avg.toFixed(1)}ms\n`;
    report += `- **Routing Latency (p95):** ${scaling.crossInstanceCommunication.messageRoutingLatency.p95.toFixed(1)}ms\n`;
    report += `- **Cluster Sync (p95):** ${scaling.crossInstanceCommunication.clusterSyncLatency.p95.toFixed(1)}ms\n\n`;
    
    // Reliability metrics
    report += '### Reliability\n\n';
    report += `- **Instance Failures:** ${scaling.reliability.instanceFailures}\n`;
    report += `- **Health Checks:** ${scaling.reliability.healthChecks.toLocaleString()}\n`;
    report += `- **Failure Rate:** ${(scaling.reliability.failureRate * 100).toFixed(3)}%\n\n`;
    
    // Scaling efficiency
    report += '### Scaling Efficiency\n\n';
    report += `- **Routing Efficiency:** ${(scaling.scalingEfficiency.messageRoutingEfficiency * 100).toFixed(1)}%\n`;
    report += `- **Load Balance Score:** ${(scaling.scalingEfficiency.loadBalanceScore * 100).toFixed(1)}%\n`;
    report += `- **Horizontal Scale Score:** ${(scaling.scalingEfficiency.horizontalScaleScore * 100).toFixed(1)}%\n\n`;
    
    // Performance assessment
    const routingStatus = scaling.crossInstanceCommunication.messageRoutingLatency.p95 < 300 ? '✅ Excellent' :
                         scaling.crossInstanceCommunication.messageRoutingLatency.p95 < 500 ? '⚠️ Good' : '❌ Poor';
    const reliabilityStatus = scaling.reliability.failureRate < 0.01 ? '✅ Excellent' :
                             scaling.reliability.failureRate < 0.05 ? '⚠️ Good' : '❌ Poor';
    const scaleStatus = scaling.scalingEfficiency.horizontalScaleScore > 0.8 ? '✅ Excellent' :
                       scaling.scalingEfficiency.horizontalScaleScore > 0.6 ? '⚠️ Good' : '❌ Poor';
    
    report += '### Assessment\n\n';
    report += `- **Message Routing:** ${routingStatus}\n`;
    report += `- **Reliability:** ${reliabilityStatus}\n`;
    report += `- **Scaling Effectiveness:** ${scaleStatus}\n\n`;
    
    return report;
  }

  createRecommendations() {
    let recommendations = '## 💡 Performance Recommendations\n\n';
    
    const issues = [];
    const suggestions = [];
    
    // Analyze results and generate recommendations
    if (this.results.connection) {
      const conn = this.results.connection;
      if (conn.connections.successRate < 0.95) {
        issues.push('Low connection success rate');
        suggestions.push('Consider increasing connection timeout and optimizing connection handling');
      }
      if (conn.connections.connectionTime.p95 > 1000) {
        issues.push('High connection latency');
        suggestions.push('Optimize WebSocket upgrade process and reduce connection overhead');
      }
    }
    
    if (this.results.throughput) {
      const throughput = this.results.throughput;
      if (throughput.throughput.avgMessagesPerSecond < 1000) {
        issues.push('Low message throughput');
        suggestions.push('Optimize message processing pipeline and consider connection pooling');
      }
      if (throughput.latency.message.p95 > 100) {
        issues.push('High message latency');
        suggestions.push('Optimize message routing and reduce serialization overhead');
      }
    }
    
    if (this.results.scaling) {
      const scaling = this.results.scaling;
      if (scaling.scalingEfficiency.horizontalScaleScore < 0.7) {
        issues.push('Poor horizontal scaling');
        suggestions.push('Optimize inter-instance communication and load balancing strategy');
      }
      if (scaling.reliability.failureRate > 0.02) {
        issues.push('High instance failure rate');
        suggestions.push('Improve error handling and implement better health checks');
      }
    }
    
    if (issues.length === 0) {
      recommendations += '✅ **All performance metrics are within acceptable ranges!**\n\n';
      recommendations += '### Optimization Opportunities\n\n';
      recommendations += '- Monitor memory usage patterns for potential optimizations\n';
      recommendations += '- Consider implementing connection pooling for high-traffic scenarios\n';
      recommendations += '- Evaluate message batching strategies for improved throughput\n\n';
    } else {
      recommendations += '### Issues Identified\n\n';
      issues.forEach(issue => {
        recommendations += `- ❌ ${issue}\n`;
      });
      recommendations += '\n### Suggested Improvements\n\n';
      suggestions.forEach(suggestion => {
        recommendations += `- 💡 ${suggestion}\n`;
      });
      recommendations += '\n';
    }
    
    return recommendations;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Main execution
async function main() {
  const resultsDir = process.argv[2] || './results';
  
  try {
    const generator = new PerformanceReportGenerator(resultsDir);
    const report = await generator.generateReport();
    console.log(report);
  } catch (error) {
    console.error('Error generating report:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = PerformanceReportGenerator;