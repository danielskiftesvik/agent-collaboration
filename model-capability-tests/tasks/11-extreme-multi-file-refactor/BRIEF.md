Refactor the codebase under `src/` to support atomic database transactions. You need to propagate the transaction context (`tx`) across multiple dependent service modules.

### Current Architecture:
* `src/db.mjs`: Implements the `Database` class. It has transaction capabilities (`db.transaction(fn)`) but the service modules do not pass or accept transaction context.
* `src/user-service.mjs`: Implements `UserService`, which registers users.
* `src/order-service.mjs`: Implements `OrderService`, which creates an order and registers its user.

### Requirements:
1. **Propagate Transaction Context:** Refactor both `UserService.registerUser(name, email, tx)` and `OrderService.createOrderAndUser(orderId, name, email, tx)` to accept an optional transaction context `tx` and pass it to all underlying database operations.
2. **Transaction Scoping in `OrderService`:** In `OrderService.createOrderAndUser`, if an active transaction context `tx` is passed from the caller, execute the operations within that transaction. If NO `tx` is passed, wrap the creation of both the user and the order in a new transaction (`this.db.transaction`).
3. **Atomic Rollback:** If any operation in `createOrderAndUser` fails, the transaction must roll back completely (neither the user nor the order should be saved to the database).
4. **Backward Compatibility:** Calling service methods without a `tx` argument must continue to work normally (non-transactional inserts).

Do not edit the test file.

Then run: node --test test/refactor.test.mjs
Expected: all tests pass.

When finished, return ONLY a JSON object:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
