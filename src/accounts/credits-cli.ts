// Grants page credits by hand until the back office does it (E-14, E-20).
//   npm run credits -- grant <org_id> <pages> "note"
//   npm run credits -- balance <org_id>
import { readDatabaseConfig } from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";
import { balance, grantCredits } from "./credits.ts";

const [command, orgId, pages, note] = process.argv.slice(2);
const db = connect(readDatabaseConfig(process.env).databaseUrl, 1);
try {
  if (!orgId || (command !== "grant" && command !== "balance")) {
    console.error(
      'usage: npm run credits -- grant <org_id> <pages> "note" | balance <org_id>',
    );
    process.exitCode = 1;
  } else {
    if (command === "grant")
      await grantCredits(
        db,
        orgId,
        Number(pages),
        note ?? "granted by hand",
        "cli",
      );
    console.log(`${orgId}: ${String(await balance(db, orgId))} page credits`);
  }
} finally {
  await db.close();
}
