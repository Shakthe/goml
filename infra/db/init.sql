-- Source of truth for stock and orders. Redis is the fast gate in front of it,
-- but these constraints make overselling impossible even if Redis were wrong.

CREATE TABLE products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  price_inr   integer NOT NULL CHECK (price_inr > 0)
);

CREATE TABLE inventory (
  product_id  text PRIMARY KEY REFERENCES products (id),
  stock       integer NOT NULL CHECK (stock >= 0),
  version     integer NOT NULL DEFAULT 0   -- used only by the optimistic-locking lab strategy
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  sale_id          text NOT NULL,
  product_id       text NOT NULL REFERENCES products (id),
  user_id          text NOT NULL,
  idempotency_key  text NOT NULL,
  status           text NOT NULL CHECK (status IN ('CONFIRMED', 'FAILED')),
  strategy         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_order_per_user_per_sale UNIQUE (sale_id, user_id),
  CONSTRAINT one_order_per_idempotency_key UNIQUE (sale_id, idempotency_key)
);

CREATE INDEX orders_sale_status_idx ON orders (sale_id, status);

INSERT INTO products (id, name, price_inr) VALUES ('nova-x1', 'Shak-V1', 49999);
INSERT INTO inventory (product_id, stock) VALUES ('nova-x1', 500);
