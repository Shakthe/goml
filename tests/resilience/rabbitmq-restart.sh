#!/usr/bin/env bash
# Restarts RabbitMQ under a running stack and checks the order pipeline recovers:
# both workers consume again and a new order still reaches CONFIRMED.
# Before the worker exited on a lost connection, it stayed up with no consumer and
# this test failed at step 3.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${BASE_URL:-http://localhost:8080}"
ADMIN="${ADMIN_TOKEN:-dev-admin-token}"
hdr=$(mktemp)
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
fail() { echo "FAIL: $*"; exit 1; }

echo "1. start a sale with 5 units"
started=no
for i in $(seq 1 30); do # the stack may still be starting up
  if curl -sf -X POST "$BASE/api/admin/sale" -H "X-Admin-Token: $ADMIN" -H 'Content-Type: application/json' \
    -H "X-Forwarded-For: 100.90.0.$i" -d '{"stock":5,"startsInSeconds":0,"strategy":"queue"}' > /dev/null; then
    started=yes; break
  fi
  sleep 2
done
[ "$started" = yes ] || fail "could not start sale"

echo "2. restart RabbitMQ"
docker compose restart rabbitmq > /dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q rabbitmq)")" = healthy ] && break
  sleep 2
done

echo "3. wait for both workers to consume again"
consumers=0
for _ in $(seq 1 45); do
  consumers=$(docker compose exec -T rabbitmq rabbitmqctl -q list_queues name consumers 2>/dev/null \
    | awk '$1=="checkout.orders"{print $2}')
  [ "${consumers:-0}" -ge 2 ] && break
  sleep 2
done
[ "${consumers:-0}" -ge 2 ] || fail "checkout.orders has ${consumers:-0} consumers, expected 2"
echo "   consumers: $consumers"

echo "4. wait for the API replicas to be healthy again"
for _ in $(seq 1 45); do
  [ "$(docker compose ps --format '{{.Status}}' api | grep -c '(healthy)')" -ge 4 ] && break
  sleep 2
done
sleep 2 # let every replica load the sale

echo "5. place an order and wait for CONFIRMED"
session=$(curl -sf -X POST "$BASE/api/session" -H 'X-Forwarded-For: 100.90.0.2')
token=$(echo "$session" | json .token)
key="resilience$(date +%s)"
# The API replicas also restart when RabbitMQ goes away, so a 5xx right after is expected.
# Retry with the same idempotency key, as the storefront does.
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/checkout" -H "Authorization: Bearer $token" \
    -H "Idempotency-Key: $key" -H 'Content-Type: application/json' -H "X-Forwarded-For: 100.90.1.$i" -d '{}' \
    -D "$hdr")
  [ "$code" -lt 500 ] && break
  sleep 1
done
[ "$code" = 202 ] || fail "checkout returned $code, expected 202"
location=$(grep -i '^location:' "$hdr" | tr -d '\r' | awk '{print $2}')
status=PENDING
for _ in $(seq 1 30); do
  status=$(curl -sf "$BASE$location" -H "Authorization: Bearer $token" -H 'X-Forwarded-For: 100.90.0.4' | json .status)
  [ "$status" = CONFIRMED ] && break
  sleep 1
done
[ "$status" = CONFIRMED ] || fail "order still $status after 30 s"
echo "PASS: pipeline recovered after a RabbitMQ restart (order $status)"
