const si = require('systeminformation');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const SAMPLE_INTERVAL = 1000; // 1 second
const OUTPUT_DIR = path.join(__dirname, '../results');
const SOCKUDO_PROCESS_NAME = 'sockudo';

class SystemMetricsCollector {
  constructor() {
    this.metrics = [];
    this.isCollecting = false;
    this.startTime = null;
    this.sockudoPid = null;
  }

  async findSockudoProcess() {
    try {
      const processes = await si.processes();
      const sockudoProcess = processes.list.find(p => 
        p.name.includes(SOCKUDO_PROCESS_NAME) || 
        p.command.includes(SOCKUDO_PROCESS_NAME)
      );
      
      if (sockudoProcess) {
        this.sockudoPid = sockudoProcess.pid;
        console.log(`Found Sockudo process with PID: ${this.sockudoPid}`);
        return sockudoProcess;
      }
      
      console.warn('Sockudo process not found, will monitor system-wide metrics');
      return null;
    } catch (error) {
      console.error('Error finding Sockudo process:', error);
      return null;
    }
  }

  async collectMetrics() {
    try {
      const timestamp = Date.now();
      const elapsed = (timestamp - this.startTime) / 1000;

      // Get system-wide metrics
      const [cpu, mem, network, fsSize] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats(),
        si.fsSize()
      ]);

      // Get process-specific metrics if we have a PID
      let processMetrics = null;
      if (this.sockudoPid) {
        try {
          const processes = await si.processes();
          processMetrics = processes.list.find(p => p.pid === this.sockudoPid);
        } catch (error) {
          console.warn('Error getting process metrics:', error);
        }
      }

      // Get Docker container metrics if running in container
      let containerMetrics = null;
      try {
        const containers = await si.dockerContainers();
        const sockudoContainer = containers.find(c => 
          c.name.includes('sockudo') || c.image.includes('sockudo')
        );
        if (sockudoContainer) {
          containerMetrics = await si.dockerContainerStats(sockudoContainer.id);
        }
      } catch (error) {
        // Not in Docker or Docker not available
      }

      // Calculate network throughput
      const primaryInterface = network[0] || {};
      
      const metric = {
        timestamp,
        elapsed,
        system: {
          cpu: {
            usage: cpu.currentLoad,
            cores: cpu.cpus.length,
            loadAvg: cpu.avgLoad,
          },
          memory: {
            total: mem.total,
            used: mem.used,
            free: mem.free,
            usedPercent: (mem.used / mem.total) * 100,
            available: mem.available,
            swapUsed: mem.swapused,
          },
          network: {
            rxSec: primaryInterface.rx_sec || 0,
            txSec: primaryInterface.tx_sec || 0,
            rxBytes: primaryInterface.rx_bytes || 0,
            txBytes: primaryInterface.tx_bytes || 0,
          },
          disk: fsSize.map(fs => ({
            fs: fs.fs,
            used: fs.used,
            available: fs.available,
            usePercent: fs.use,
          })),
        }
      };

      // Add process-specific metrics if available
      if (processMetrics) {
        metric.process = {
          pid: processMetrics.pid,
          name: processMetrics.name,
          cpu: processMetrics.cpu,
          memory: processMetrics.mem,
          memoryRss: processMetrics.memRss,
          memoryVsz: processMetrics.memVsz,
        };
      }

      // Add container metrics if available
      if (containerMetrics) {
        metric.container = {
          id: containerMetrics.id,
          name: containerMetrics.name,
          cpuPercent: containerMetrics.cpuPercent,
          memUsage: containerMetrics.memUsage,
          memLimit: containerMetrics.memLimit,
          memPercent: containerMetrics.memPercent,
          netIO: {
            rx: containerMetrics.netIO.rx,
            tx: containerMetrics.netIO.tx,
          },
        };
      }

      // Get Sockudo-specific metrics from Prometheus endpoint if available
      try {
        const prometheusMetrics = await this.getPrometheusMetrics();
        if (prometheusMetrics) {
          metric.sockudo = prometheusMetrics;
        }
      } catch (error) {
        // Prometheus endpoint not available
      }

      this.metrics.push(metric);
      
      // Log current stats
      console.log(`[${elapsed.toFixed(1)}s] CPU: ${cpu.currentLoad.toFixed(1)}% | ` +
                  `Memory: ${((mem.used / mem.total) * 100).toFixed(1)}% | ` +
                  `Network: ↓${this.formatBytes(primaryInterface.rx_sec)}/s ↑${this.formatBytes(primaryInterface.tx_sec)}/s`);
      
      if (processMetrics) {
        console.log(`  └─ Sockudo: CPU: ${processMetrics.cpu.toFixed(1)}% | Memory: ${processMetrics.mem.toFixed(1)}%`);
      }

    } catch (error) {
      console.error('Error collecting metrics:', error);
    }
  }

  async getPrometheusMetrics() {
    try {
      const response = await fetch('http://localhost:9601/metrics');
      if (!response.ok) return null;
      
      const text = await response.text();
      const metrics = {};
      
      // Parse relevant Sockudo metrics
      const patterns = {
        connections: /sockudo_active_connections\s+(\d+)/,
        messages: /sockudo_messages_total\s+(\d+)/,
        channels: /sockudo_active_channels\s+(\d+)/,
        subscriptions: /sockudo_subscriptions_total\s+(\d+)/,
      };
      
      for (const [key, pattern] of Object.entries(patterns)) {
        const match = text.match(pattern);
        if (match) {
          metrics[key] = parseInt(match[1]);
        }
      }
      
      return Object.keys(metrics).length > 0 ? metrics : null;
    } catch (error) {
      return null;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async start() {
    console.log('Starting system metrics collection...');
    
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    
    // Find Sockudo process
    await this.findSockudoProcess();
    
    this.isCollecting = true;
    this.startTime = Date.now();
    this.metrics = [];
    
    // Collect initial metric
    await this.collectMetrics();
    
    // Set up interval for continuous collection
    this.interval = setInterval(() => {
      if (this.isCollecting) {
        this.collectMetrics();
      }
    }, SAMPLE_INTERVAL);
  }

  async stop() {
    console.log('\nStopping metrics collection...');
    this.isCollecting = false;
    
    if (this.interval) {
      clearInterval(this.interval);
    }
    
    // Save metrics to file
    const filename = `system-metrics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(OUTPUT_DIR, filename);
    
    const summary = this.generateSummary();
    
    const output = {
      startTime: this.startTime,
      endTime: Date.now(),
      duration: (Date.now() - this.startTime) / 1000,
      sampleInterval: SAMPLE_INTERVAL,
      summary,
      metrics: this.metrics,
    };
    
    await fs.writeFile(filepath, JSON.stringify(output, null, 2));
    console.log(`\nMetrics saved to: ${filepath}`);
    console.log('\nSummary:');
    console.log(JSON.stringify(summary, null, 2));
  }

  generateSummary() {
    if (this.metrics.length === 0) return {};
    
    const cpuValues = this.metrics.map(m => m.system.cpu.usage);
    const memoryValues = this.metrics.map(m => m.system.memory.usedPercent);
    const networkRx = this.metrics.map(m => m.system.network.rxSec);
    const networkTx = this.metrics.map(m => m.system.network.txSec);
    
    const summary = {
      system: {
        cpu: {
          avg: this.average(cpuValues),
          max: Math.max(...cpuValues),
          min: Math.min(...cpuValues),
          p95: this.percentile(cpuValues, 0.95),
        },
        memory: {
          avg: this.average(memoryValues),
          max: Math.max(...memoryValues),
          min: Math.min(...memoryValues),
          p95: this.percentile(memoryValues, 0.95),
        },
        network: {
          rxAvg: this.average(networkRx),
          rxMax: Math.max(...networkRx),
          txAvg: this.average(networkTx),
          txMax: Math.max(...networkTx),
        },
      },
    };
    
    // Add process summary if available
    const processMetrics = this.metrics.filter(m => m.process);
    if (processMetrics.length > 0) {
      const processCpu = processMetrics.map(m => m.process.cpu);
      const processMem = processMetrics.map(m => m.process.memory);
      
      summary.process = {
        cpu: {
          avg: this.average(processCpu),
          max: Math.max(...processCpu),
          p95: this.percentile(processCpu, 0.95),
        },
        memory: {
          avg: this.average(processMem),
          max: Math.max(...processMem),
          p95: this.percentile(processMem, 0.95),
        },
      };
    }
    
    // Add Sockudo metrics summary if available
    const sockudoMetrics = this.metrics.filter(m => m.sockudo);
    if (sockudoMetrics.length > 0) {
      const connections = sockudoMetrics.map(m => m.sockudo.connections || 0);
      const messages = sockudoMetrics.map(m => m.sockudo.messages || 0);
      
      summary.sockudo = {
        connections: {
          max: Math.max(...connections),
          final: connections[connections.length - 1],
        },
        messages: {
          total: messages[messages.length - 1],
          rate: messages.length > 1 ? 
            (messages[messages.length - 1] - messages[0]) / ((Date.now() - this.startTime) / 1000) : 0,
        },
      };
    }
    
    return summary;
  }

  average(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  percentile(arr, p) {
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[index];
  }
}

// Main execution
const collector = new SystemMetricsCollector();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await collector.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await collector.stop();
  process.exit(0);
});

// Start collection
collector.start().catch(console.error);

console.log('System metrics collector is running. Press Ctrl+C to stop.');