import { Injectable } from "@nestjs/common";
import { UsersRepository } from "../../users/repositories/users.repository";
import { AuthFailure } from "../domain/auth-failure";

@Injectable()
export class GetMe {
  constructor(private readonly users: UsersRepository) {}

  async execute(userId: string): Promise<{ userId: string; email: string }> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new AuthFailure("unauthorized", "invalid access token");
    }
    return { userId: user._id, email: user.email };
  }
}
