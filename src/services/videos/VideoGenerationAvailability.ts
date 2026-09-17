import type SystemSculptPlugin from "../../main";
import {
  getPluginCapabilityAvailability,
  type PluginCapabilityAvailabilityOptions,
  type PluginCapabilityAvailabilityResolution,
} from "../api/PluginCapabilityAvailability";

export type VideoGenerationAvailabilityOptions = PluginCapabilityAvailabilityOptions;
export type VideoGenerationAvailabilityResolution = PluginCapabilityAvailabilityResolution;

export async function canRunVideoGeneration(
  plugin: SystemSculptPlugin,
  options: VideoGenerationAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<boolean> {
  return (await getVideoGenerationAvailability(plugin, options, signal)).canOpen;
}

export function getVideoGenerationAvailability(
  plugin: SystemSculptPlugin,
  options: VideoGenerationAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<VideoGenerationAvailabilityResolution> {
  return getPluginCapabilityAvailability(plugin, "hosted_videos", options, signal);
}
