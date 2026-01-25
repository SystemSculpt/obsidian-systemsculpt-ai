import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const filePath = resolve("src/constants/api.ts");
const prodLine = "export const DEVELOPMENT_MODE: \"DEVELOPMENT\" | \"PRODUCTION\" = \"PRODUCTION\";";
const devLine = "export const DEVELOPMENT_MODE: \"DEVELOPMENT\" | \"PRODUCTION\" = \"DEVELOPMENT\";";

async function run() {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    console.error(`Failed to read ${filePath}`, error);
    process.exitCode = 1;
    return;
  }

  let nextLine;
  if (contents.includes(prodLine)) {
    contents = contents.replace(prodLine, devLine);
    nextLine = "DEVELOPMENT";
  } else if (contents.includes(devLine)) {
    contents = contents.replace(devLine, prodLine);
    nextLine = "PRODUCTION";
  } else {
    console.error("Unable to locate DEVELOPMENT_MODE declaration to toggle.");
    process.exitCode = 1;
    return;
  }

  await writeFile(filePath, contents, "utf8");
  console.log(`DEVELOPMENT_MODE switched to ${nextLine}.`);
}

run();
