package sale;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;

@DisplayName("Gateway")
class GatewayTest extends ApiSupport {

  @Test
  @DisplayName("requests from scraping libraries are blocked with 403")
  void blocksBots() {
    startSale(10, 0, "queue");
    for (String ua : List.of("python-requests/2.31", "Go-http-client/1.1", "Scrapy/2.11")) {
      given().header("User-Agent", ua).header("X-Forwarded-For", randomIp())
          .post("/api/checkout").then().statusCode(403).body("code", equalTo("BLOCKED"));
    }
  }

  @Test
  @DisplayName("one IP hammering checkout is rate limited with 429, other IPs are unaffected")
  void rateLimitsPerIp() {
    startSale(10, 0, "queue");
    String token = newSessionToken();
    String key = newKey();
    String ip = randomIp();
    List<Integer> codes = new ArrayList<>();
    for (int i = 0; i < 20; i++) codes.add(checkout(token, key, ip).statusCode());

    assertTrue(codes.contains(429), "expected some 429s, got " + codes);
    assertTrue(codes.stream().allMatch(c -> c == 202 || c == 429), "unexpected status in " + codes);
    // A different client is still served normally.
    checkout(newSessionToken(), newKey(), randomIp()).then().statusCode(202);
  }

  @Test
  @DisplayName("traffic is spread across all API replicas")
  void loadBalanced() {
    Set<String> instances = new HashSet<>();
    for (int i = 0; i < 40; i++) instances.add(client().get("/api/health").header("X-Served-By"));
    assertTrue(instances.size() >= 2, "only saw " + instances);
  }

  @Test
  @DisplayName("static assets are served with long-lived cache headers")
  void staticAssetsCached() {
    String html = client().get("/").then().statusCode(200).header("Cache-Control", "no-cache").extract().asString();
    String asset = html.replaceAll("(?s).*?src=\"(/assets/[^\"]+\\.js)\".*", "$1");
    client().get(asset).then().statusCode(200)
        .header("Cache-Control", containsString("immutable"));
  }
}
