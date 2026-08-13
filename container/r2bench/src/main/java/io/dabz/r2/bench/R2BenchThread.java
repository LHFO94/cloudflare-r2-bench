package io.dabz.r2.bench;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.client.config.ClientOverrideConfiguration;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.Date;
import java.util.LinkedList;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

public class R2BenchThread implements Runnable {
	S3Client s3Client = null;

	String s3ClientId;
	String s3ClientSecret;
	String s3Uri;

	AtomicBoolean isRunning = new AtomicBoolean(true);
	Logger logger = LoggerFactory.getLogger(R2BenchThread.class);

	public R2BenchThread(String s3ClientId, String s3ClientSecret, String s3Uri) {
		this.s3ClientId = s3ClientId;
		this.s3ClientSecret = s3ClientSecret;
		this.s3Uri = s3Uri;
	}

	@SuppressWarnings({"BusyWait"})
	@Override
	public void run() {
		initS3Clients();

		while(isRunning.get()) {
			var start = new Date().getTime();
			try {
				ResponseInputStream<GetObjectResponse> responseStream = this.s3Client.getObject(GetObjectRequest.builder()
					.bucket(getRandomBucket())
					.key("bench.tar")
					.build());
				byte[] buffer = new byte[1024];
				while (responseStream.read() >= 0) {
					continue;
				}
				var end = new Date().getTime();

				Coordinator.main.incrementCount();
				Coordinator.main.incrementLatency(end - start);
				var estimatedSleep = Coordinator.main.getEstimatedSleep();
				if (estimatedSleep > 0) {
					Thread.sleep(estimatedSleep);
				}
			} catch (IOException e) {
				logger.error("IOException while executing threads", e);
				throw new RuntimeException(e);
			} catch (InterruptedException e) {
				logger.error("Thread interrupted", e);
				System.out.println(e.getMessage());
			} catch (Exception e) {
				var end = new Date().getTime();
				Coordinator.main.incrementError(end - start);
				logger.error("Unexpected exception while executing threads", e);
				continue;
			};

		}
	}

	private void initS3Clients() {
		try {
			this.s3Client = S3Client.builder()
				.region(Region.US_EAST_1)
				.endpointOverride(new URI(this.s3Uri))
				.credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(s3ClientId, s3ClientSecret)))
				.overrideConfiguration(ClientOverrideConfiguration.builder()
					.apiCallTimeout(Duration.ofSeconds(30))
					.apiCallAttemptTimeout(Duration.ofSeconds(10))
					.build())
				.build();
		} catch (Exception e) {
			logger.error("Failed to initialize S3 client", e);
			throw new RuntimeException(e);
		}
	}

	private static String getRandomBucket() {
		int index = new Random().nextInt(25);
		return String.format("r2-bench-%02d", index);
	}
}
