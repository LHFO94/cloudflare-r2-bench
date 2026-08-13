package io.dabz.r2.bench;

import com.codahale.metrics.MetricRegistry;
import com.codahale.metrics.json.MetricsModule;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.server.Request;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.handler.AbstractHandler;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

public class MetricsHttpServer {
	private static final String METRICS_PATH = "/metrics";

	public static Server start(MetricRegistry metrics, int port) throws Exception {
		Server server = new Server(port);
		ObjectMapper mapper = new ObjectMapper()
			.registerModule(new MetricsModule(TimeUnit.SECONDS, TimeUnit.MILLISECONDS, false));

		server.setHandler(new AbstractHandler() {
			@Override
			public void handle(String target, Request baseRequest, HttpServletRequest request, HttpServletResponse response) throws IOException {
				if (!METRICS_PATH.equals(target)) {
					return;
				}

				baseRequest.setHandled(true);
				if (!"GET".equals(request.getMethod())) {
					response.setStatus(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
					return;
				}

				response.setStatus(HttpServletResponse.SC_OK);
				response.setContentType("application/json");
				response.setCharacterEncoding("UTF-8");
				mapper.writeValue(response.getWriter(), metrics);
			}
		});

		server.start();
		return server;
	}
}
