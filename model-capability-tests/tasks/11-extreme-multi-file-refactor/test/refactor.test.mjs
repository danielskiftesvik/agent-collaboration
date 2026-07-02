import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db.mjs";
import { UserService } from "../src/user-service.mjs";
import { OrderService } from "../src/order-service.mjs";

test("backward compatibility: inserts without tx work normally", async () => {
  const db = new Database();
  const userService = new UserService(db);
  const orderService = new OrderService(db, userService);

  await userService.registerUser("Alice", "alice@example.com");
  assert.equal(await db.count("users"), 1);

  await orderService.createOrderAndUser("order-1", "Bob", "bob@example.com");
  assert.equal(await db.count("users"), 2);
  assert.equal(await db.count("orders"), 1);
});

test("atomic operations: createOrderAndUser rolls back both on failure when no tx passed", async () => {
  const db = new Database();
  const userService = new UserService(db);
  const orderService = new OrderService(db, userService);

  // Failure scenario: invalid email
  await assert.rejects(
    orderService.createOrderAndUser("order-2", "Charlie", "invalid-email"),
    /Invalid email/
  );

  // Both should be rolled back and not exist in DB
  assert.equal(await db.count("users"), 0);
  assert.equal(await db.count("orders"), 0);
});

test("atomic operations: respects external transaction and rolls back on failure", async () => {
  const db = new Database();
  const userService = new UserService(db);
  const orderService = new OrderService(db, userService);

  // We run an external transaction
  await assert.rejects(
    db.transaction(async (tx) => {
      // Register one valid user first in transaction
      await userService.registerUser("Dave", "dave@example.com", tx);
      // Run order creation that fails
      await orderService.createOrderAndUser("order-3", "Eve", "invalid-email", tx);
    }),
    /Invalid email/
  );

  // Everything in transaction should be rolled back
  assert.equal(await db.count("users"), 0);
  assert.equal(await db.count("orders"), 0);
});

test("transaction visibility: operations can see uncommitted inserts within transaction", async () => {
  const db = new Database();
  const userService = new UserService(db);
  const orderService = new OrderService(db, userService);

  await db.transaction(async (tx) => {
    await userService.registerUser("Alice", "alice@example.com", tx);
    // Uncommitted insert should be visible inside transaction count
    assert.equal(await db.count("users", tx), 1);
    // But invisible outside it
    assert.equal(await db.count("users"), 0);
  });

  // Committed now, visible outside
  assert.equal(await db.count("users"), 1);
});
