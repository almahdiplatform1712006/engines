// Creates one organisation and prints one API key (E-05). Local and staging use.
//   npm run seed -- "Organisation name" [--explanation]
import { readDatabaseConfig } from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";
import { grantEntitlement } from "./entitlements.ts";
import { createApiKey, createOrganisation } from "./keys.ts";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "Local organisation";
const db = connect(readDatabaseConfig(process.env).databaseUrl, 1);
try {
  const orgId = await createOrganisation(db, name);
  if (args.includes("--explanation"))
    await grantEntitlement(db, orgId, "explanation");
  const { key } = await createApiKey(db, orgId, "seed");
  console.log(
    `organisation ${orgId} (${name})${args.includes("--explanation") ? " with explanation" : ""}`,
  );
  console.log(`api key (shown once): ${key}`);
} finally {
  await db.close();
}
