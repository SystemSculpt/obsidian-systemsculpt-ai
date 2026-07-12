import esbuild from "esbuild";
import process from "process";
import {
	CANONICAL_API_BASE_URL,
	createPluginBuildOptions,
	normalizeApiBaseUrl,
	resolveWebsiteApiBaseUrl,
} from "./scripts/plugin-build-options.mjs";
import fs from "fs";
import path from "path";
import { BuildLogger, formatBytes, formatDuration } from "./build-logger.mjs";
import { createBuildSyncController } from "./scripts/plugin-sync.mjs";

const prod = (process.argv[2] === "production");
const apiBaseUrl = normalizeApiBaseUrl(
	process.env.SYSTEMSCULPT_API_BASE_URL || CANONICAL_API_BASE_URL,
);
const websiteApiBaseUrl = resolveWebsiteApiBaseUrl({
	apiBaseUrl,
	websiteApiBaseUrl: process.env.SYSTEMSCULPT_WEBSITE_API_BASE_URL,
});
const logger = new BuildLogger("Build");
const cssLogger = new BuildLogger("CSS");

const cssDir = path.join(process.cwd(), "src", "css");
const indexCssPath = path.join(cssDir, "index.css");
const syncQuiet = /^(?:1|true|yes|on)$/i.test(String(process.env.SYSTEMSCULPT_AUTO_SYNC_QUIET || "").trim());
const buildSyncController = createBuildSyncController({
	env: process.env,
	root: process.cwd(),
	logger,
	quiet: syncQuiet,
});
const ensureCssSourcesExist = () => {
	if (!fs.existsSync(indexCssPath)) {
		throw new Error(`CSS entry file missing at ${indexCssPath}`);
	}
};

const parseImports = (cssFile) => {
	const content = fs.readFileSync(cssFile, "utf8");
	const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
	const regex = /@import\s+['"](.+)['"]/g;
	const imports = [];
	let match;
	while ((match = regex.exec(withoutComments)) !== null) {
		imports.push(match[1]);
	}
	return imports;
};

const resolveCssPath = (importPath, basePath) => path.join(path.dirname(basePath), importPath);

const buildCSS = () => {
	try {
		ensureCssSourcesExist();
		const startTime = Date.now();
		const imports = parseImports(indexCssPath);
		let combinedCSS = `/**\n * SystemSculpt CSS\n * Generated from src/css/ sources.\n * DO NOT EDIT DIRECTLY.\n */\n\n`;
		let processedCount = 0;
		const missingFiles = [];

		imports.forEach(importPath => {
			const resolvedPath = resolveCssPath(importPath, indexCssPath);
			if (fs.existsSync(resolvedPath)) {
				const content = fs.readFileSync(resolvedPath, "utf8");
				combinedCSS += `/* ${path.basename(importPath)} */\n${content}\n\n`;
				processedCount++;
			} else {
				missingFiles.push(importPath);
			}
		});

		fs.writeFileSync("styles.css", combinedCSS);
		const duration = Date.now() - startTime;
		cssLogger.success(`Built CSS (${processedCount} files, ${formatDuration(duration)})`);
		if (missingFiles.length > 0) {
			cssLogger.warn(`Missing imports: ${missingFiles.join(", ")}`);
		}
		return combinedCSS;
	} catch (error) {
		cssLogger.error("CSS build failed", error.message ?? error);
		fs.writeFileSync("styles.css", "/* CSS build failed */\n");
		return null;
	}
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
	websiteApiBaseUrl,
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
					finalizeBuild(buildStart, { watch: !prod && isWatching });
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
		if (!prod) {
			buildSyncController.schedule();
		}
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
		if (prod) {
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
