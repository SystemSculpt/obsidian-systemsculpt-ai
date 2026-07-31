import esbuild from "esbuild";
import process from "process";
import {
	CANONICAL_API_BASE_URL,
	createPluginBuildOptions,
	normalizeApiBaseUrl,
	resolvePluginBuildStamp,
	resolveTestDriverFlag,
} from "./scripts/plugin-build-options.mjs";
import fs from "fs";
import path from "path";
import { BuildLogger, formatBytes, formatDuration } from "./build-logger.mjs";
import { buildCssArtifact } from "./scripts/build-css.mjs";
import { assertSafePluginArtifactPathsForBuild } from "./scripts/plugin-artifacts.mjs";
import { createBuildSyncController } from "./scripts/plugin-sync.mjs";

const productionWatch = process.argv[2] === "production-watch";
const prod = process.argv[2] === "production" || productionWatch;
const shouldWatch = !prod || productionWatch;
const apiBaseUrl = normalizeApiBaseUrl(
	process.env.SYSTEMSCULPT_API_BASE_URL || CANONICAL_API_BASE_URL,
);
const logger = new BuildLogger("Build");
const cssLogger = new BuildLogger("CSS");
assertSafePluginArtifactPathsForBuild({ root: process.cwd() });

const cssDir = path.join(process.cwd(), "src", "css");
const indexCssPath = path.join(cssDir, "index.css");
const stylesOutputPath = path.join(process.cwd(), "styles.css");
const manifestVersion = JSON.parse(
	fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"),
).version;
const buildStamp = resolvePluginBuildStamp({
	version: manifestVersion,
	override: process.env.SYSTEMSCULPT_BUILD_STAMP,
	production: prod,
});
const syncQuiet = /^(?:1|true|yes|on)$/i.test(String(process.env.SYSTEMSCULPT_AUTO_SYNC_QUIET || "").trim());
const buildSyncController = createBuildSyncController({
	env: process.env,
	root: process.cwd(),
	logger,
	quiet: syncQuiet,
});

const buildCSS = () => {
	return buildCssArtifact({
		indexPath: indexCssPath,
		outputPath: stylesOutputPath,
		production: prod,
		logger: cssLogger,
	});
};

const watchCss = () => {
	if (!fs.existsSync(cssDir)) {
		return;
	}
	fs.watch(cssDir, { recursive: true }, (eventType, filename) => {
		if (filename && filename.endsWith(".css")) {
			cssLogger.info(`File changed: ${filename}`);
			buildCSS();
			buildSyncController.schedule();
		}
	});
};

const buildOptions = createPluginBuildOptions({
	production: prod,
	apiBaseUrl,
	buildStamp,
	testDriver: resolveTestDriverFlag({
		production: prod,
		override: process.env.SYSTEMSCULPT_TEST_DRIVER,
	}),
	plugins: [
		{
			name: "build-reporter",
			setup(build) {
				build.onEnd(result => {
					if (result.errors.length > 0) {
						logger.error(`Build failed with ${result.errors.length} errors`);
						result.errors.forEach(error => {
							logger.error(error.text, error.location);
						});
					}

					if (result.warnings.length > 0) {
						logger.warn(`Build completed with ${result.warnings.length} warnings`);
					}
				});
			}
		},
		{
			name: "finalize-assets",
			setup(build) {
				let buildStart = Date.now();
				build.onStart(() => {
					buildStart = Date.now();
				});
				build.onEnd((result) => {
					if (result.errors.length > 0) {
						return;
					}
					finalizeBuild(buildStart, { watch: isWatching });
				});
			}
		}
	],
});

let isWatching = false;

const finalizeBuild = (startedAt, { watch } = {}) => {
	buildCSS();
	const mainStats = fs.statSync("main.js");
	const duration = Date.now() - startedAt;

	if (watch) {
		logger.info(`Rebuild updated assets (${formatDuration(duration)})`);
		logger.info(`Main bundle size: ${formatBytes(mainStats.size)}`);
		buildSyncController.schedule();
		return;
	}

	logger.divider();
	logger.success(`Build complete (${formatDuration(duration)})`);
	logger.info(`Main bundle size: ${formatBytes(mainStats.size)}`);
	logger.divider();
	if (!prod) {
		buildSyncController.schedule();
	}
};

const run = async () => {
	try {
		if (!shouldWatch) {
			await esbuild.build(buildOptions);
			return;
		}

		const ctx = await esbuild.context(buildOptions);
		isWatching = true;
		await ctx.watch();
		watchCss();
		logger.info("Watching for changes...");
	} catch (error) {
		logger.error("Build failed", error);
		process.exit(1);
	}
};

run();
