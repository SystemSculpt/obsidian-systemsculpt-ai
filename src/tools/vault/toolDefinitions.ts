import type { FirstPartyToolDefinition } from "../types";
import { fileToolDefinitions } from "./toolDefinitions/fileToolDefinitions";
import { directoryToolDefinitions } from "./toolDefinitions/directoryToolDefinitions";
import { searchToolDefinitions } from "./toolDefinitions/searchToolDefinitions";
import { managementToolDefinitions } from "./toolDefinitions/managementToolDefinitions";

/**
 * Combined canonical vault tool definitions.
 */
export const toolDefinitions: FirstPartyToolDefinition[] = [
  ...fileToolDefinitions,
  ...directoryToolDefinitions,
  ...searchToolDefinitions,
  ...managementToolDefinitions
];
