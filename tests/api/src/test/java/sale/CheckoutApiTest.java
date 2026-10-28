package sale;

import io.restassured.response.Response;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.awaitility.Awaitility.await;
import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;

@DisplayName("Checkout API")
class CheckoutApiTest extends ApiSupport {

  @Test
  @DisplayName("sale endpoint returns product, stock and server time")
  void saleView() {
    startSale(500, 60, "queue");
    client().get("/api/sale").then()
        .statusCode(200)
        .body("state", equalTo("upcoming"))
        .body("totalStock", equalTo(500))
        .body("remaining", equalTo(500))
        .body("product.name", equalTo("Shak-V1"))
        .body("serverTime", greaterThan(0L))
        .body("startsAt", greaterThan(0L));
  }

  @Test
  @DisplayName("checkout before the sale opens returns 425 with the start time")
  void tooEarly() {
    startSale(10, 60, "queue");
    checkout(newSessionToken(), newKey()).then()
        .statusCode(425)
        .body("code", equalTo("NOT_STARTED"))
        .body("startsAt", notNullValue());
  }

  @Test
  @DisplayName("checkout returns 202 with a tracking URL, and the order is confirmed by the worker")
  void acceptedThenConfirmed() {
    startSale(10, 0, "queue");
    String token = newSessionToken();
    Response res = checkout(token, newKey());
    res.then()
        .statusCode(202)
        .header("Location", startsWith("/api/orders/"))
        .body("status", equalTo("PENDING"))
        .body("orderId", matchesPattern("[0-9a-f-]{36}"))
        .body("statusUrl", equalTo(res.header("Location")));

    String statusUrl = res.path("statusUrl");
    await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(200)).untilAsserted(() ->
        client().header("Authorization", "Bearer " + token).get(statusUrl).then()
            .statusCode(200).body("status", equalTo("CONFIRMED")));

    await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
        stats().then().body("dbStock", equalTo(9)).body("redisStock", equalTo(9)).body("confirmedOrders", equalTo(1)));
  }

  @Test
  @DisplayName("retrying with the same Idempotency-Key returns the same order, not a new one")
  void idempotentRetry() {
    startSale(10, 0, "queue");
    String token = newSessionToken();
    String key = newKey();
    String first = checkout(token, key).then().statusCode(202).extract().path("orderId");
    String second = checkout(token, key).then().statusCode(202).extract().path("orderId");
    assertEquals(first, second);
    await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
        stats().then().body("confirmedOrders", equalTo(1)).body("redisStock", equalTo(9)));
  }

  @Test
  @DisplayName("one unit per customer: a second checkout with a new key is refused")
  void onePerCustomer() {
    startSale(10, 0, "queue");
    String token = newSessionToken();
    String orderId = checkout(token, newKey()).then().statusCode(202).extract().path("orderId");
    checkout(token, newKey()).then()
        .statusCode(409)
        .body("code", equalTo("ALREADY_PURCHASED"))
        .body("orderId", equalTo(orderId));
  }

  @Test
  @DisplayName("when stock runs out the next buyer gets 409 SOLD_OUT")
  void soldOut() {
    startSale(1, 0, "queue");
    checkout(newSessionToken(), newKey()).then().statusCode(202);
    checkout(newSessionToken(), newKey()).then().statusCode(409).body("code", equalTo("SOLD_OUT"));
  }

  @Test
  @DisplayName("checkout requires a valid session and an Idempotency-Key")
  void validation() {
    startSale(10, 0, "queue");
    checkout("not-a-real-token", newKey()).then().statusCode(401);
    String forged = java.util.UUID.randomUUID() + ".forgedsignature";
    checkout(forged, newKey()).then().statusCode(401);
    checkout(newSessionToken(), "short").then().statusCode(400).body("code", equalTo("BAD_IDEMPOTENCY_KEY"));
  }

  @Test
  @DisplayName("an order can only be read by the customer who placed it")
  void orderPrivacy() {
    startSale(10, 0, "queue");
    String owner = newSessionToken();
    String statusUrl = checkout(owner, newKey()).then().statusCode(202).extract().path("statusUrl");
    client().header("Authorization", "Bearer " + owner).get(statusUrl).then().statusCode(200);
    client().header("Authorization", "Bearer " + newSessionToken()).get(statusUrl).then().statusCode(404);
    client().get(statusUrl).then().statusCode(401);
  }

  @Test
  @DisplayName("malformed requests get a 4xx, never a 500")
  void clientErrorsStayClientErrors() {
    client().contentType("application/xml").body("<a/>").post("/api/session").then().statusCode(415);
    client().header("X-Admin-Token", ADMIN_TOKEN).contentType("application/json")
        .body("{not json").post("/api/admin/sale").then().statusCode(400);
  }

  @Test
  @DisplayName("admin endpoint needs the admin token and validates its input")
  void adminAuth() {
    client().contentType("application/json").body("{}").post("/api/admin/sale").then().statusCode(401);
    client().header("X-Admin-Token", ADMIN_TOKEN).contentType("application/json")
        .body("{\"stock\": -5}").post("/api/admin/sale").then().statusCode(400);
    client().header("X-Admin-Token", ADMIN_TOKEN).contentType("application/json")
        .body("{\"strategy\": \"drop table\"}").post("/api/admin/sale").then().statusCode(400);
  }
}
