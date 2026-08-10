import crypto from "node:crypto";

export const PLUGIN_ARTIFACT_ID_PREFIX = "SystemSculptPluginArtifact/v1:";
export const PLUGIN_ARTIFACT_ID_HEX_LENGTH = 32;
export const TEST_DRIVER_ARTIFACT_MODULE =
  "virtual:systemsculpt-test-driver-artifact";
export const PLUGIN_ARTIFACT_ID_PLUGIN_NAME =
  "systemsculpt-test-driver-artifact";

const ARTIFACT_NAMESPACE = "systemsculpt-test-driver-artifact";
const ARTIFACT_MODULE_FILTER = /^virtual:systemsculpt-test-driver-artifact$/;
const VALID_ARTIFACT_PATTERN = new RegExp(
  `${PLUGIN_ARTIFACT_ID_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    + `[a-f0-9]{${PLUGIN_ARTIFACT_ID_HEX_LENGTH}}(?![A-Za-z0-9])`,
  "g",
);

export function createPluginArtifactId(randomBytes = crypto.randomBytes) {
  const entropy = randomBytes(PLUGIN_ARTIFACT_ID_HEX_LENGTH / 2);
  if (!Buffer.isBuffer(entropy) || entropy.length !== PLUGIN_ARTIFACT_ID_HEX_LENGTH / 2) {
    throw new Error("Plugin artifact identity generation returned invalid entropy.");
  }
  return `${PLUGIN_ARTIFACT_ID_PREFIX}${entropy.toString("hex")}`;
}

export function inspectPluginArtifactIdentity(bundle) {
  const text = typeof bundle === "string" ? bundle : String(bundle ?? "");
  const prefixCount = text.split(PLUGIN_ARTIFACT_ID_PREFIX).length - 1;
  const validCount = text.match(VALID_ARTIFACT_PATTERN)?.length ?? 0;
  return Object.freeze({ prefixCount, validCount });
}

/**
 * Extracts the one immutable identity compiled into a driver-enabled bundle.
 * Errors intentionally contain neither bundle contents, identifiers, nor paths.
 */
export function extractPluginArtifactId(bundle) {
  const text = typeof bundle === "string" ? bundle : String(bundle ?? "");
  const { prefixCount, validCount } = inspectPluginArtifactIdentity(text);
  if (prefixCount === 0) {
    throw new Error("Compiled plugin artifact identity is missing.");
  }
  if (prefixCount !== 1 || validCount > 1) {
    throw new Error("Compiled plugin artifact identity is ambiguous.");
  }
  if (validCount !== 1) {
    throw new Error("Compiled plugin artifact identity is malformed.");
  }
  return text.match(VALID_ARTIFACT_PATTERN)[0];
}

/**
 * Provides a fresh, content-free artifact identity every time esbuild loads the
 * driver-only virtual module. esbuild invokes onLoad again for every rebuild.
 */
export function createPluginArtifactIdentityPlugin({
  enabled = true,
  createArtifactId = createPluginArtifactId,
} = {}) {
  return {
    name: PLUGIN_ARTIFACT_ID_PLUGIN_NAME,
    setup(build) {
      let artifactId = null;
      build.onStart(() => {
        artifactId = enabled ? createArtifactId() : "";
        if (!enabled) return;
        // Validate injected generators as strictly as production entropy.
        if (extractPluginArtifactId(artifactId) !== artifactId) {
          throw new Error("Plugin artifact identity generation returned an invalid identity.");
        }
      });
      build.onResolve({ filter: ARTIFACT_MODULE_FILTER }, () => ({
        path: TEST_DRIVER_ARTIFACT_MODULE,
        namespace: ARTIFACT_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: ARTIFACT_NAMESPACE }, () => {
        if (artifactId === null) {
          throw new Error("Plugin artifact identity was not initialized for this build.");
        }
        return {
          contents: `export const TEST_DRIVER_ARTIFACT_ID = ${JSON.stringify(artifactId)};`,
          loader: "js",
        };
      });
    },
  };
}
