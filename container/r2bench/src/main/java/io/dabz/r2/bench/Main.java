package io.dabz.r2.bench;

import com.codahale.metrics.ConsoleReporter;
import org.eclipse.jetty.server.Server;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.LinkedList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class Main {
	static Logger logger = LoggerFactory.getLogger(Main.class);

	public static void main(String[] args) throws Exception {
		java.security.Security.setProperty("networkaddress.cache.ttl", "1000");
		Main main = new Main();
		try {
			main.run();
		} catch (Exception e) {
			logger.error("Unexpected error", e);
			System.exit(1);
		}
	}

	void run() throws Exception {
		int concurrency = Integer.parseInt(System.getenv("CONCURRENCY"));
		int targetRps = Integer.parseInt(System.getenv("TARGET_RPS"));
		int duration = Integer.parseInt(System.getenv("DURATION"));
		long stopAtEpochMs = Long.parseLong(System.getenv().getOrDefault("STOP_AT_EPOCH_MS", "0"));
		int metricsPort = Integer.parseInt(System.getenv().getOrDefault("METRICS_PORT", "8080"));
		String s3ClientId = System.getenv("S3_CLIENT_ID");
		String s3ClientSecret = System.getenv("S3_CLIENT_SECRET");
		String s3Uri = System.getenv("S3_URI");

		prefetch(s3Uri);
		validateConfiguration(concurrency, targetRps, metricsPort, s3ClientId, s3ClientSecret, s3Uri);
		Coordinator.init(concurrency, targetRps);

		ConsoleReporter reporter = ConsoleReporter.forRegistry(Coordinator.main.metrics)
			.convertRatesTo(TimeUnit.SECONDS)
			.convertDurationsTo(TimeUnit.MILLISECONDS)
			.build();
		reporter.start(30, TimeUnit.SECONDS);
		Server metricsServer = MetricsHttpServer.start(Coordinator.main.metrics, metricsPort);
		logger.info("Metrics endpoint listening on http://0.0.0.0:{}/metrics", metricsPort);

		try {
			var taskLists = new LinkedList<R2BenchThread>();
			try (ExecutorService executorService = Executors.newFixedThreadPool(concurrency)) {
				for (int i = 0; i < concurrency; i++) {
					if (stopAtEpochMs > 0 && System.currentTimeMillis() >= stopAtEpochMs) {
						break;
					}

					R2BenchThread task = new R2BenchThread(s3ClientId, s3ClientSecret, s3Uri);
					executorService.submit(task);
					taskLists.push(task);
					Thread.sleep(15_000); // backoff time between each tasks to avoid overloading R2 right away
				}

				long sleepDurationMs = stopAtEpochMs > 0 ? stopAtEpochMs - System.currentTimeMillis() : (long) duration * 60 * 1000;
				if (sleepDurationMs > 0) {
					Thread.sleep(sleepDurationMs);
				}
				for (var task: taskLists) {
					task.isRunning.set(false);
				}

				if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
					logger.warn("Timing out while waiting for all tasks to finalize");
				}
			}
		} finally {
			reporter.stop();
			metricsServer.stop();
		}
	}

	private void prefetch(String hostname) {
		try {
			String host = hostname.replaceAll("https?://", "");
			InetAddress[] addresses = InetAddress.getAllByName(host);
			logger.info("DNS Prefetch Success: prefeteched {}", host);
		} catch (UnknownHostException e) {
			logger.error("DNS Prefetch Failed: Could not resolve {} ", hostname, e);
			throw new RuntimeException(e);
		}
	}


	private static void validateConfiguration(int concurrency, int targetRps, int metricsPort, String s3ClientId, String s3ClientSecret, String s3Uri) {
		if (concurrency <= 0) {
			throw new RuntimeException("Invalid concurrency provided " + concurrency);
		}

		if (targetRps <= 0) {
			throw new RuntimeException("Invalid target RPS provided " + targetRps);
		}

		if (metricsPort <= 0 || metricsPort > 65535) {
			throw new RuntimeException("Invalid metrics port provided " + metricsPort);
		}

		if (s3ClientId == null) {
			throw new RuntimeException("S3 client ID not provided");
		}

		if (s3ClientSecret == null) {
			throw new RuntimeException("S3 client secret not provided");
		}

		if (s3Uri == null) {
			throw new RuntimeException("S3 URI not provided");
		}
	}
}
