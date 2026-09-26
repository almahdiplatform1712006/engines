// `npm run admin -- <email>`: makes the person with this email Engines'
// super admin (E-20), the one account that sees the back office. They sign up
// on the page first. `--revoke` takes it away.
import { readDatabaseConfig } from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const email = args.find((a) => !a.startsWith("--"));
if (!email) {
  console.error("usage: npm run admin -- <email> [--revoke]");
  process.exit(1);
}
const db = connect(readDatabaseConfig(process.env).databaseUrl);
try {
  const { rowCount } = await db.query(
    "UPDATE users SET super_admin = $2 WHERE lower(email) = lower($1)",
    [email, !revoke],
  );
  if (rowCount === 0) {
    console.error(
      `No account with the email ${email}; sign up on the page first.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `${email} ${revoke ? "is no longer" : "is now"} a super admin.`,
    );
  }
} finally {
  await db.close();
}
