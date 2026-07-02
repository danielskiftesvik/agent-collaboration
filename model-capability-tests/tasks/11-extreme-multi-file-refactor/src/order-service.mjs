export class OrderService {
  constructor(db, userService) {
    this.db = db;
    this.userService = userService;
  }

  async createOrderAndUser(orderId, name, email) {
    // TODO: support transactions. If an active transaction context is passed, 
    // run inside it. Otherwise, create a new transaction to wrap these operations.
    await this.userService.registerUser(name, email);
    await this.db.insert("orders", { id: orderId, email });
  }
}
