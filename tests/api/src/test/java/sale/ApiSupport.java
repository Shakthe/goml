package sale;

import io.restassured.RestAssured;
import io.restassured.builder.RequestSpecBuilder;
import io.restassured.http.ContentType;
import io.restassured.response.Response;
import io.restassured.specification.RequestSpecification;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

import static io.restassured.RestAssured.given;
import static org.awaitility.Awaitility.await;

/** Shared helpers. Every request gets its own client IP so the per-IP rate limit only bites where a test wants it to. */
abstract class ApiSupport {
  static final String BASE_URL = System.getenv().getOrDefault("BASE_URL", "http://localhost:8080");
  static final String ADMIN_TOKEN = System.getenv().getOrDefault("ADMIN_TOKEN", "dev-admin-token");

  static {
    RestAssured.baseURI = BASE_URL;
    RestAssured.requestSpecification = new RequestSpecBuilder()
        .addHeader("User-Agent", "flash-sale-api-tests")
        .build();
  }

  static String randomIp() {
    ThreadLocalRandom r = ThreadLocalRandom.current();
    return "100." + (64 + r.nextInt(64)) + "." + r.nextInt(256) + "." + (1 + r.nextInt(254));
  }

  static RequestSpecification client() {
    return given().header("X-Forwarded-For", randomIp());
  }

  static Response startSale(int stock, int startsInSeconds, String strategy) {
    Response res = client()
        .header("X-Admin-Token", ADMIN_TOKEN)
        .contentType(ContentType.JSON)
        .body(Map.of("stock", stock, "startsInSeconds", startsInSeconds, "strategy", strategy))
        .post("/api/admin/sale");
    res.then().statusCode(200);
    // Every API replica refreshes its view of the sale every 500 ms.
    String saleId = res.path("saleId");
    await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(200))
        .until(() -> allReplicasSee(saleId));
    return res;
  }

  private static boolean allReplicasSee(String saleId) {
    for (int i = 0; i < 12; i++) {
      if (!saleId.equals(client().get("/api/sale").path("saleId"))) return false;
    }
    return true;
  }

  static String newSessionToken() {
    return client().contentType(ContentType.JSON).body("{}").post("/api/session").then().statusCode(201).extract().path("token");
  }

  static String newKey() {
    return UUID.randomUUID().toString().replace("-", "");
  }

  static Response checkout(String token, String idempotencyKey) {
    return checkout(token, idempotencyKey, randomIp());
  }

  static Response checkout(String token, String idempotencyKey, String ip) {
    return given()
        .header("X-Forwarded-For", ip)
        .header("Authorization", "Bearer " + token)
        .header("Idempotency-Key", idempotencyKey)
        .contentType(ContentType.JSON)
        .body("{}")
        .post("/api/checkout");
  }

  static Response stats() {
    return client().get("/api/stats");
  }
}
