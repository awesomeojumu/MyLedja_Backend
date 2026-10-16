import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Db, MongoClient } from "mongodb";
import { loadConfig } from "../../config/env";
import { connectMongo } from "./connect";
import { MONGO_CLIENT, MONGO_DB } from "./mongo.constants";

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      useFactory: async (): Promise<MongoClient> => {
        const { mongodbUri } = loadConfig();
        if (!mongodbUri) {
          throw new Error("MONGODB_URI is required");
        }
        return connectMongo(mongodbUri);
      },
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT],
      useFactory: (client: MongoClient): Db => client.db(loadConfig().mongodbDb),
    },
  ],
  exports: [MONGO_CLIENT, MONGO_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
