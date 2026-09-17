import process from "node:process";

const REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

export function createRepositoryScopedGitEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const canonicalName = name.toUpperCase();
    if (
      REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES.has(canonicalName)
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(canonicalName)
    ) {
      delete result[name];
    }
  }
  return result;
}
