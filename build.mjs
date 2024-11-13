import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import builtins from "builtin-modules";

const cssDir = "src/css";
const isWatchMode = process.argv.includes("--watch");

async function combineCssFiles() {
  const files = await fs.readdir(cssDir);
  const cssFiles = files.filter(file => file.endsWith('.css'));
  let combinedCss = '';
  
  for (const file of cssFiles) {
    const content = await fs.readFile(path.join(cssDir, file), 'utf8');
    combinedCss += content + '\n';
  }
  
  await fs.writeFile('styles.css', combinedCss);
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2018",
  outfile: "dist/main.js",
  platform: "browser",
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
    "global": "window"
  },
  alias: {
    crypto: "crypto-browserify"
  }
});

await ctx.rebuild();
await combineCssFiles();
await fs.rename('dist/main.js', 'main.js');

if (isWatchMode) {
  await ctx.watch();
  // Watch CSS directory
  const cssWatcher = fs.watch(cssDir, async (eventType, filename) => {
    if (filename?.endsWith('.css')) {
      await combineCssFiles();
    }
  });
  
  process.on('SIGINT', () => {
    cssWatcher.close();
    ctx.dispose();
    process.exit(0);
  });
} else {
  ctx.dispose();
} 