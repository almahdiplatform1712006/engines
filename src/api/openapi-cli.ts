// `npm run openapi` writes openapi.json from the Zod schemas, and the typed
// client's types (client/src/schema.ts) from openapi.json;
// `npm run openapi -- --check` fails when either has drifted (CI).
import { readFile, writeFile } from "node:fs/promises";
import { API_VERSION, openApi } from "./openapi.ts";
import { schemaTypes } from "./openapi-types.ts";

const spec = openApi(API_VERSION);
const files = [
  {
    url: new URL("../../openapi.json", import.meta.url),
    text: `${JSON.stringify(spec, null, 2)}\n`,
  },
  {
    url: new URL("../../client/src/schema.ts", import.meta.url),
    text: schemaTypes(
      (
        spec["components"] as {
          schemas: Record<string, Record<string, unknown>>;
        }
      ).schemas,
    ),
  },
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const file of files) {
    if ((await readFile(file.url, "utf8").catch(() => "")) !== file.text) {
      console.error(
        `${file.url.pathname} is out of date with the Zod schemas.`,
      );
      stale = true;
    }
  }
  if (stale) {
    console.error("Run `npm run openapi` and commit the result.");
    process.exit(1);
  }
  console.log("openapi.json and the client's types match the schemas.");
} else {
  for (const file of files) await writeFile(file.url, file.text);
  console.log("wrote openapi.json and client/src/schema.ts");
}
