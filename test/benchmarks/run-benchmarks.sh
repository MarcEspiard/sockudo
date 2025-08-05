#!/bin/bash

# Sockudo Load Testing Runner
# Usage: ./run-benchmarks.sh [test-type] [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default values
TEST_TYPE="all"
SOCKUDO_URL="ws://localhost:6001"
APP_KEY="demo-app"
VERBOSE=false
WITH_METRICS=false
USE_DOCKER=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -t, --type TYPE       Test type: connections, throughput, channels, scaling, all (default: all)"
    echo "  -u, --url URL         Sockudo WebSocket URL (default: ws://localhost:6001)"
    echo "  -k, --key KEY         App key (default: demo-app)"
    echo "  -m, --metrics         Collect system metrics during tests"
    echo "  -d, --docker          Run tests in Docker environment"
    echo "  -v, --verbose         Verbose output"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Run all tests with defaults"
    echo "  $0 -t connections -m                 # Run connection test with metrics"
    echo "  $0 -t scaling -d -v                  # Run scaling test in Docker with verbose output"
    echo "  $0 -u ws://remote:6001 -k prod-app   # Test against remote server"
}

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--type)
            TEST_TYPE="$2"
            shift 2
            ;;
        -u|--url)
            SOCKUDO_URL="$2"
            shift 2
            ;;
        -k|--key)
            APP_KEY="$2"
            shift 2
            ;;
        -m|--metrics)
            WITH_METRICS=true
            shift
            ;;
        -d|--docker)
            USE_DOCKER=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            print_usage
            exit 1
            ;;
    esac
done

# Validate test type
case $TEST_TYPE in
    connections|throughput|channels|scaling|all)
        ;;
    *)
        log_error "Invalid test type: $TEST_TYPE"
        log "Valid types: connections, throughput, channels, scaling, all"
        exit 1
        ;;
esac

log "Starting Sockudo Load Testing"
log "Test Type: $TEST_TYPE"
log "Sockudo URL: $SOCKUDO_URL"
log "App Key: $APP_KEY"
log "Docker Mode: $USE_DOCKER"
log "System Metrics: $WITH_METRICS"

# Change to benchmark directory
cd "$SCRIPT_DIR"

# Check dependencies
if ! command -v k6 &> /dev/null && [ "$USE_DOCKER" = false ]; then
    log_error "k6 is not installed. Install k6 or use --docker flag"
    log "Installation: https://k6.io/docs/get-started/installation/"
    exit 1
fi

if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed"
    exit 1
fi

# Install npm dependencies
if [ ! -d "node_modules" ]; then
    log "Installing npm dependencies..."
    npm install
fi

# Start system metrics collection if requested
METRICS_PID=""
if [ "$WITH_METRICS" = true ]; then
    log "Starting system metrics collection..."
    node metrics/system-metrics.js &
    METRICS_PID=$!
    log "Metrics collector started with PID: $METRICS_PID"
    sleep 2
fi

# Function to cleanup on exit
cleanup() {
    if [ ! -z "$METRICS_PID" ]; then
        log "Stopping metrics collection..."
        kill $METRICS_PID 2>/dev/null || true
        wait $METRICS_PID 2>/dev/null || true
    fi
    
    if [ "$USE_DOCKER" = true ]; then
        log "Cleaning up Docker containers..."
        cd "$PROJECT_ROOT"
        docker compose -f docker-compose.benchmark.yml down --remove-orphans 2>/dev/null || true
    fi
}

trap cleanup EXIT

# Setup Docker environment if requested
if [ "$USE_DOCKER" = true ]; then
    log "Setting up Docker environment..."
    cd "$PROJECT_ROOT"
    
    # Start base services
    docker compose -f docker-compose.benchmark.yml up -d sockudo redis
    
    # Wait for Sockudo to be ready
    log "Waiting for Sockudo to be ready..."
    timeout 60 bash -c 'until curl -f http://localhost:6001/up/demo-app &>/dev/null; do sleep 2; done' || {
        log_error "Sockudo failed to start within 60 seconds"
        docker compose -f docker-compose.benchmark.yml logs sockudo
        exit 1
    }
    
    log_success "Sockudo is ready"
    
    # For scaling tests, start additional instances
    if [ "$TEST_TYPE" = "scaling" ] || [ "$TEST_TYPE" = "all" ]; then
        log "Starting additional instances for scaling test..."
        docker compose -f docker-compose.benchmark.yml --profile scaling up -d
        
        # Wait for all instances
        for port in 6002 6003; do
            log "Waiting for Sockudo instance on port $port..."
            timeout 30 bash -c "until curl -f http://localhost:$port/up/demo-app &>/dev/null; do sleep 2; done" || {
                log_warning "Instance on port $port failed to start"
            }
        done
    fi
    
    cd "$SCRIPT_DIR"
fi

# Export environment variables for k6
export SOCKUDO_URL="$SOCKUDO_URL"
export APP_KEY="$APP_KEY"
export APP_SECRET="demo-secret"

# Run the specified tests
run_test() {
    local test_name=$1
    local script_file=$2
    
    log "Running $test_name test..."
    
    local k6_cmd=""
    if [ "$USE_DOCKER" = true ]; then
        k6_cmd="docker run --rm --network host -v $(pwd):/scripts grafana/k6 run /scripts/scenarios/$script_file"
    else
        k6_cmd="k6 run scenarios/$script_file"
    fi
    
    if [ "$VERBOSE" = true ]; then
        k6_cmd="$k6_cmd --verbose"
    fi
    
    # Add environment variables
    k6_cmd="SOCKUDO_URL=$SOCKUDO_URL APP_KEY=$APP_KEY APP_SECRET=$APP_SECRET $k6_cmd"
    
    if eval $k6_cmd; then
        log_success "$test_name test completed successfully"
    else
        log_error "$test_name test failed"
        return 1
    fi
}

# Execute tests based on type
case $TEST_TYPE in
    connections)
        run_test "Connection" "connection-test.js"
        ;;
    throughput)
        run_test "Throughput" "throughput-test.js"
        ;;
    channels)
        run_test "Channel" "channel-test.js"
        ;;
    scaling)
        # For scaling tests, we need multiple instances
        if [ "$USE_DOCKER" = false ]; then
            log_warning "Scaling test requires Docker mode for multiple instances"
            log "Use --docker flag or manually start multiple Sockudo instances"
        fi
        export SOCKUDO_URL_1="$SOCKUDO_URL"
        export SOCKUDO_URL_2="ws://localhost:6002"
        export SOCKUDO_URL_3="ws://localhost:6003"
        run_test "Scaling" "scaling-test.js"
        ;;
    all)
        log "Running all test scenarios..."
        run_test "Connection" "connection-test.js" || exit 1
        run_test "Throughput" "throughput-test.js" || exit 1
        run_test "Channel" "channel-test.js" || exit 1
        
        if [ "$USE_DOCKER" = true ]; then
            # Start scaling profile if not already running
            cd "$PROJECT_ROOT"
            docker compose -f docker-compose.benchmark.yml --profile scaling up -d
            cd "$SCRIPT_DIR"
            
            export SOCKUDO_URL_1="$SOCKUDO_URL"
            export SOCKUDO_URL_2="ws://localhost:6002"
            export SOCKUDO_URL_3="ws://localhost:6003"
            run_test "Scaling" "scaling-test.js" || exit 1
        else
            log_warning "Skipping scaling test (requires Docker mode)"
        fi
        ;;
esac

# Generate report if we have results
if [ -d "results" ] && [ "$(ls -A results/)" ]; then
    log "Generating performance report..."
    node metrics/generate-report.js results/ > performance-report.md
    log_success "Performance report generated: performance-report.md"
else
    log_warning "No test results found for report generation"
fi

log_success "Load testing completed!"

# Show results summary
if [ -d "results" ]; then
    log "Results saved in: $SCRIPT_DIR/results/"
    ls -la results/ | grep -E '\.(json|txt)$' | while read -r line; do
        echo "  📄 $line"
    done
fi