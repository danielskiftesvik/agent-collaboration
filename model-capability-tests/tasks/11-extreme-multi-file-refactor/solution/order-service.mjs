export class OrderService {
  constructor(db, userService) {
    this.db = db;
    this.userService = userService;
  }

  async createOrderAndUser(orderId, name, email, tx) {
    const run = async (activeTx) => {
      await this.userService.registerUser(name, email, activeTx);
      await this.db.insert("orders", { id: orderId, email }, activeTx);
    };

    if (tx) {
      await run(tx);
    } else {
      await this.db.transaction(run);
    }
  }
}
