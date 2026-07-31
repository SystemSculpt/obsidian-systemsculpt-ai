#!/usr/bin/env node

import { buildLocalAgentPlugin } from "./plugin-artifacts.mjs";

const inspection = buildLocalAgentPlugin();
console.log(
  `[build:local-agent] Built ${inspection.mainBundle.formattedSize} for ${inspection.mainBundle.expectedApiBaseUrl}.`,
);
