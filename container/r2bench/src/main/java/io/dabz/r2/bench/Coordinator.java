package io.dabz.r2.bench;

import com.codahale.metrics.Counter;
import com.codahale.metrics.Histogram;
import com.codahale.metrics.MetricRegistry;
import com.codahale.metrics.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class Coordinator {
	private Logger logger = LoggerFactory.getLogger(Coordinator.class);
	public static Coordinator main;
	public MetricRegistry metrics;

	private final int concurrency;
	private final int targetRPS;

	private final AtomicLong totalCount = new AtomicLong(0);
	private final AtomicLong totalLatency = new AtomicLong(0);
	private Counter count;
	private Timer error;
	private Histogram latency;
	private Timer countTimer;

	public Coordinator(int concurrency, int targetRPS) {
		this.concurrency = concurrency;
		this.targetRPS = targetRPS;
	}

	public static Coordinator init(int concurrency, int targetRPS) {
		main = new Coordinator(concurrency, targetRPS);
		main.metrics = new MetricRegistry();
		main.count = main.metrics.counter("count");
		main.error = main.metrics.timer("error");
		main.countTimer = main.metrics.timer("countTimer");
		main.latency = main.metrics.histogram("latency");
		return main;
	}

	public void incrementCount() {
		this.totalCount.addAndGet(1);
		main.count.inc();
	}

	public void incrementError(long latency) {
		this.error.update(latency, TimeUnit.MILLISECONDS);
	}


	public void incrementLatency(long latency) {
		this.totalLatency.addAndGet(latency);
		main.latency.update(latency);
		main.countTimer.update(latency, TimeUnit.MILLISECONDS);
	}

	public int getEstimatedSleep() {
		var avgLatency = (totalLatency.get() * 1.0) / (totalCount.get() * 1.0);
		var targetRPSPerThread = (this.targetRPS * 1.0) / (this.concurrency * 1.0);
		var currentRPS = (1000 / avgLatency);

		if (currentRPS < targetRPSPerThread) {
			logger.debug("Current RPS {} is lower than target RPS {}, can't match the requested workload\n  Average latency is: {}\n", currentRPS, targetRPS, avgLatency);
			return 0;
		}

		var estimatedSleep = (1000 - (targetRPS * avgLatency)) / targetRPS;

		return (int) Math.floor(estimatedSleep);
	}
}
