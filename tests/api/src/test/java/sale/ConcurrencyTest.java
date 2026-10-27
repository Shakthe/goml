package sale;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.*;
import java.util.stream.Collectors;

import static org.awaitility.Awaitility.await;
import static org.hamcrest.Matchers.equalTo;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Fires many buyers at once at each checkout strategy. The queue strategy must sell
 * exactly the stock; the naive one is expected to oversell (that is the original bug).
 */
@DisplayName("Concurrency")
class ConcurrencyTest extends ApiSupport {
  static final int STOCK = 50;
  static final int BUYERS = 1000;
  static final int THREADS = 100;

  private Map<Integer, Long> stampede(String strategy) throws Exception {
    startSale(STOCK, 0, strategy);
    List<String> tokens = new ArrayList<>();
    for (int i = 0; i < BUYERS; i++) tokens.add(newSessionToken());

    ExecutorService pool = Executors.newFixedThreadPool(THREADS);
    CountDownLatch go = new CountDownLatch(1);
    List<Future<Integer>> results = new ArrayList<>();
    for (String token : tokens) {
      results.add(pool.submit(() -> {
        go.await();
        return checkout(token, newKey()).statusCode();
      }));
    }
    go.countDown();
    List<Integer> codes = new ArrayList<>();
    for (Future<Integer> f : results) codes.add(f.get(60, TimeUnit.SECONDS));
    pool.shutdown();
    Map<Integer, Long> byCode = codes.stream().collect(Collectors.groupingBy(c -> c, TreeMap::new, Collectors.counting()));
    System.out.printf("[%s] %d buyers, %d units -> responses %s%n", strategy, BUYERS, STOCK, byCode);
    return byCode;
  }

  private int confirmedOrders() {
    return stats().then().statusCode(200).extract().path("confirmedOrders");
  }

  @Test
  @DisplayName("queue strategy: 1000 simultaneous buyers, 50 units -> exactly 50 orders")
  void queueSellsExactlyTheStock() throws Exception {
    Map<Integer, Long> byCode = stampede("queue");
    assertEquals(STOCK, byCode.getOrDefault(202, 0L), "accepted orders");
    assertEquals(BUYERS - STOCK, byCode.getOrDefault(409, 0L), "sold-out responses");
    assertTrue(byCode.keySet().stream().noneMatch(c -> c >= 500), "server errors: " + byCode);

    await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> stats().then()
        .body("confirmedOrders", equalTo(STOCK))
        .body("dbStock", equalTo(0))
        .body("redisStock", equalTo(0))
        .body("queue.depth", equalTo(0))
        .body("queue.deadLetters", equalTo(0)));
  }

  @Test
  @DisplayName("naive SELECT-then-UPDATE strategy oversells (reproduces the original bug)")
  void naiveOversells() throws Exception {
    stampede("naive");
    int sold = confirmedOrders();
    System.out.printf("[naive] confirmed orders: %d for %d units%n", sold, STOCK);
    assertTrue(sold > STOCK, "expected the naive path to oversell, but it sold " + sold);
  }

  @Test
  @DisplayName("pessimistic locking never oversells")
  void pessimisticIsCorrect() throws Exception {
    stampede("pessimistic");
    assertEquals(STOCK, confirmedOrders());
  }

  @Test
  @DisplayName("optimistic locking never oversells")
  void optimisticIsCorrect() throws Exception {
    stampede("optimistic");
    int sold = confirmedOrders();
    System.out.printf("[optimistic] confirmed orders: %d for %d units%n", sold, STOCK);
    assertTrue(sold <= STOCK, "oversold: " + sold);
  }
}
