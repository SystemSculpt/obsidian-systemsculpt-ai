import esbuild from "esbuild";
import fs from "fs/promises";
import fsSync from "fs";
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
  await fs.copyFile('styles.css', 'main.css');
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
  console.log('👀 Starting watch mode...');
  await ctx.watch();
  
  const watcher = fsSync.watch('src', { recursive: true }, async (eventType, filename) => {
    if (!filename) return;
    
    console.log(`\n🔄 File changed: ${filename}`);
    
    try {
      if (filename.endsWith('.css')) {
        console.log('📝 Rebuilding CSS...');
        await combineCssFiles();
      }
      
      console.log('🛠️  Rebuilding bundle...');
      await ctx.rebuild();
      await fs.copyFile('dist/main.js', 'main.js');
      console.log('✅ Rebuild complete\n');
    } catch (error) {
      console.error('❌ Error during rebuild:', error);
    }
  });
  
  console.log('📦 Watching src directory for changes...\n');
  
  process.on('SIGINT', () => {
    console.log('\n👋 Stopping watch mode...');
    watcher.close();
    ctx.dispose();
    process.exit(0);
  });
} else {
  ctx.dispose();
} 