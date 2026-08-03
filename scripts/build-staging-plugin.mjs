#!/usr/bin/env node

import { buildStagingPlugin } from "./plugin-artifacts.mjs";

const inspection = buildStagingPlugin();
console.log(
  `[build:staging] Built ${inspection.mainBundle.formattedSize} for ${inspection.mainBundle.expectedApiBaseUrl}.`,
);
