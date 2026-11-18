#!/usr/bin/env node

import { constants } from "node:fs";
import { copyFile, chmod } from "node:fs/promises";
import process from "node:process";

const TEMPLATE_PATH = ".env.slack.example";
const TARGET_PATH = ".env.local";

await main().catch(handleFatalError);

async function main() {
  try {
    await copyFile(TEMPLATE_PATH, TARGET_PATH, constants.COPYFILE_EXCL);
  } catch (error) {
    if (isExistingFileError(error)) {
      console.log(`${TARGET_PATH} already exists; left it unchanged.`);
      return;
    }

    throw error;
  }

  await chmod(TARGET_PATH, 0o600);
  console.log(`Created ${TARGET_PATH} with mode 0600.`);
  console.log("Run pnpm slack:cli:setup, then pnpm slack:m6:credentials.");
}

function isExistingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
