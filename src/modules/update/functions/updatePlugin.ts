import { UpdateModule } from '../UpdateModule';
import { requestUrl, PluginManifest } from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export async function updatePlugin(plugin: UpdateModule): Promise<void> {
  try {
    const response = await requestUrl({
      url: 'https://api.github.com/repos/SystemSculpt/obsidian-systemsculpt-ai/releases/latest',
      method: 'GET',
    });
    const data = response.json;
    const latestRelease = data.tag_name;
    const manifest = plugin.plugin.manifest as PluginManifest;
    const pluginId = manifest.id;
    //@ts-ignore
    const vaultPath = plugin.plugin.app.vault.adapter.basePath;
    const pluginPath = join(vaultPath, '.obsidian', 'plugins', pluginId);

    console.log('Vault Path:', vaultPath);
    console.log('Plugin ID:', pluginId);
    console.log('Plugin Path:', pluginPath);

    if (!existsSync(pluginPath)) {
      console.error('Plugin directory does not exist:', pluginPath);
      return; // Exit if plugin directory does not exist
    }

    const assets = data.assets;
    const stylesAsset = assets.find(
      (asset: any) => asset.name === 'styles.css'
    );
    const mainAsset = assets.find((asset: any) => asset.name === 'main.js');
    const manifestAsset = assets.find(
      (asset: any) => asset.name === 'manifest.json'
    );

    if (stylesAsset && mainAsset && manifestAsset) {
      // Download and update styles.css
      const stylesResponse = await requestUrl({
        url: stylesAsset.browser_download_url,
      });
      const stylesFilePath = join(pluginPath, 'styles.css');
      if (existsSync(stylesFilePath)) {
        console.log('Overwriting styles.css at:', stylesFilePath);
        writeFileSync(stylesFilePath, Buffer.from(stylesResponse.arrayBuffer));
      } else {
        console.error('styles.css does not exist and will not be overwritten.');
      }

      // Download and update main.js
      const mainResponse = await requestUrl({
        url: mainAsset.browser_download_url,
      });
      const mainFilePath = join(pluginPath, 'main.js');
      if (existsSync(mainFilePath)) {
        console.log('Overwriting main.js at:', mainFilePath);
        writeFileSync(mainFilePath, Buffer.from(mainResponse.arrayBuffer));
      } else {
        console.error('main.js does not exist and will not be overwritten.');
      }

      // Download and update manifest.json
      const manifestResponse = await requestUrl({
        url: manifestAsset.browser_download_url,
      });
      const manifestFilePath = join(pluginPath, 'manifest.json');
      if (existsSync(manifestFilePath)) {
        console.log('Overwriting manifest.json at:', manifestFilePath);
        writeFileSync(
          manifestFilePath,
          Buffer.from(manifestResponse.arrayBuffer)
        );
      } else {
        console.error(
          'manifest.json does not exist and will not be overwritten.'
        );
      }

      // Reload the plugin
      const app = plugin.plugin.app as any;
      await app.plugins.disablePlugin(pluginId);
      await app.plugins.enablePlugin(pluginId);

      showCustomNotice(
        `SystemSculpt AI has been updated to version ${latestRelease} successfully!`
      );
    } else {
      throw new Error('Required assets not found in the release.');
    }
  } catch (error) {
    console.error('Error updating plugin:', error);
    showCustomNotice(
      'Failed to update SystemSculpt AI. Please try again later.'
    );
  }
}
