export class Database {
  constructor() {
    this.state = {
      users: [],
      orders: []
    };
  }

  async insert(table, record, tx) {
    if (tx) {
      tx.operations.push({ type: "insert", table, record });
    } else {
      this.state[table].push({ ...record });
    }
  }

  async count(table, tx) {
    let list = this.state[table];
    if (tx) {
      list = [...list];
      for (const op of tx.operations) {
        if (op.table === table && op.type === "insert") {
          list.push(op.record);
        }
      }
    }
    return list.length;
  }

  async find(table, queryFn, tx) {
    let list = this.state[table];
    if (tx) {
      list = [...list];
      for (const op of tx.operations) {
        if (op.table === table && op.type === "insert") {
          list.push(op.record);
        }
      }
    }
    return list.find(queryFn) || null;
  }

  async transaction(fn) {
    const tx = { operations: [] };
    try {
      await fn(tx);
      // commit
      for (const op of tx.operations) {
        if (op.type === "insert") {
          this.state[op.table].push({ ...op.record });
        }
      }
    } catch (err) {
      // rollback (discard tx.operations)
      throw err;
    }
  }
}
