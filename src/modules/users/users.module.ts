import { Module } from "@nestjs/common";
import { UsersRepository } from "@/modules/users/repositories/users.repository";

@Module({
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
