// Creates one organisation and prints one API key (E-05). Local and staging use.
//   npm run seed -- "Organisation name"
import { readDatabaseConfig } from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";
import { createApiKey, createOrganisation } from "./keys.ts";

const name = process.argv[2] ?? "Local organisation";
const db = connect(readDatabaseConfig(process.env).databaseUrl, 1);
try {
  const orgId = await createOrganisation(db, name);
  const { key } = await createApiKey(db, orgId, "seed");
  console.log(`organisation ${orgId} (${name})`);
  console.log(`api key (shown once): ${key}`);
} finally {
  await db.close();
}
