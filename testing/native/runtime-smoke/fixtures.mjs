import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_BUNDLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/runtime-smoke"
);

async function readFixtureText(name) {
  return await fs.readFile(path.join(FIXTURE_BUNDLE_DIR, name), "utf8");
}

async function readFixtureBase64(name) {
  const buffer = await fs.readFile(path.join(FIXTURE_BUNDLE_DIR, name));
  return buffer.toString("base64");
}

export async function loadFixtureBundle() {
  return {
    textFiles: [
      {
        name: "alpha.md",
        content: await readFixtureText("alpha.md"),
      },
      {
        name: "beta.md",
        content: await readFixtureText("beta.md"),
      },
    ],
    binaryFiles: [
      {
        name: "audio-phrases.m4a",
        base64: await readFixtureBase64("audio-phrases.m4a"),
      },
    ],
  };
}

function buildSeedExpression(fixtureDir, bundle) {
  return `(async () => {
    const fixtureDir = ${JSON.stringify(fixtureDir)};
    const textFiles = ${JSON.stringify(bundle.textFiles)};
    const binaryFiles = ${JSON.stringify(bundle.binaryFiles)};
    const outputFiles = [
      'runtime-output-write.md',
      'android-output-write.md',
      'desktop-output-write.md',
    ];
    const ensureFolder = async (folderPath) => {
      const parts = String(folderPath || '').split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? \`\${current}/\${part}\` : part;
        if (app.vault.getAbstractFileByPath(current)) {
          continue;
        }
        try {
          await app.vault.createFolder(current);
        } catch (error) {
          const message = String(error?.message || error || '');
          if (!/exist/i.test(message)) {
            throw error;
          }
        }
      }
    };
    const bytesFromBase64 = (base64) => {
      const binary = globalThis.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    };
    const waitForFile = async (filePath, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = app.vault.getAbstractFileByPath(filePath);
        if (match) {
          return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };
    const upsertText = async (filePath, content) => {
      const existing = app.vault.getAbstractFileByPath(filePath);
      if (existing) {
        await app.vault.modify(existing, content);
        return;
      }
      await app.vault.create(filePath, content);
    };
    const upsertBinary = async (filePath, base64) => {
      const existing = app.vault.getAbstractFileByPath(filePath);
      const buffer = bytesFromBase64(base64);
      if (existing) {
        if (typeof app.vault.adapter?.writeBinary === 'function') {
          await app.vault.adapter.writeBinary(filePath, buffer);
          return;
        }
        throw new Error('Vault adapter.writeBinary is unavailable');
      }
      await app.vault.createBinary(filePath, buffer);
    };
    const removeOutputFile = async (filePath) => {
      const existing = app.vault.getAbstractFileByPath(filePath);
      if (!existing) return false;
      if (typeof app.vault.delete === 'function') {
        await app.vault.delete(existing, true);
        return true;
      }
      if (typeof app.vault.trash === 'function') {
        await app.vault.trash(existing, true);
        return true;
      }
      return false;
    };

    await ensureFolder(fixtureDir);

    for (const entry of textFiles) {
      await upsertText(\`\${fixtureDir}/\${entry.name}\`, entry.content);
    }
    for (const entry of binaryFiles) {
      await upsertBinary(\`\${fixtureDir}/\${entry.name}\`, entry.base64);
    }
    const removedOutputs = [];
    for (const name of outputFiles) {
      const filePath = \`\${fixtureDir}/\${name}\`;
      removedOutputs.push({ path: filePath, removed: await removeOutputFile(filePath) });
    }

    const status = {};
    for (const entry of [...textFiles, ...binaryFiles]) {
      const filePath = \`\${fixtureDir}/\${entry.name}\`;
      status[filePath] = Boolean(await waitForFile(filePath));
    }

    return {
      fixtureDir,
      status,
      removedOutputs,
      listedPaths: app.vault
        .getFiles()
        .filter((file) => file.path.startsWith(fixtureDir))
        .map((file) => file.path)
        .sort(),
    };
  })()`;
}

export async function seedFixtureBundle(runtime, fixtureDir) {
  const bundle = await loadFixtureBundle();
  return await runtime.evaluate(buildSeedExpression(fixtureDir, bundle), 60000);
}
