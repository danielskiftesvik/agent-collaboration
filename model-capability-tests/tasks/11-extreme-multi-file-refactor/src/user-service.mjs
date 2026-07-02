export class UserService {
  constructor(db) {
    this.db = db;
  }

  async registerUser(name, email) {
    if (!email.includes("@")) {
      throw new Error("Invalid email");
    }
    // TODO: support optional transaction context propagation
    await this.db.insert("users", { name, email });
  }
}
