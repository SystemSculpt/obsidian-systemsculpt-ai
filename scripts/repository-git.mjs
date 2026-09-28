import process from "node:process";
import { execFileSync } from "node:child_process";

// Git exports these to hooks and child commands. From a linked worktree
// GIT_DIR is absolute, so a git command meant for a fixture or temp repository
// would otherwise operate on the repository that launched it. Only variables
// that can redirect or reconfigure the target repository are removed;
// GIT_CEILING_DIRECTORIES stays because it can only narrow discovery.
// scripts/git-hooks/pre-push unsets the same names before running the gate.
export const REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

const REPOSITORY_ROUTING_NAMES = new Set(REPOSITORY_ROUTING_GIT_ENVIRONMENT_VARIABLES);

export function createRepositoryScopedGitEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const canonicalName = name.toUpperCase();
    if (
      REPOSITORY_ROUTING_NAMES.has(canonicalName)
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(canonicalName)
    ) {
      delete result[name];
    }
  }
  return result;
}

/** Runs git against the repository named by its arguments, never an inherited one. */
export function execRepositoryGitSync(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env: createRepositoryScopedGitEnvironment(options.env),
  });
}
