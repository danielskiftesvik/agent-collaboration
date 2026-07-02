export class UserService {
  constructor(db) {
    this.db = db;
  }

  async registerUser(name, email, tx) {
    if (!email.includes("@")) {
      throw new Error("Invalid email");
    }
    await this.db.insert("users", { name, email }, tx);
  }
}
