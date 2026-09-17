import type SystemSculptPlugin from "../../main";
import {
  getPluginCapabilityAvailability,
  type PluginCapabilityAvailabilityOptions,
  type PluginCapabilityAvailabilityResolution,
} from "../../services/api/PluginCapabilityAvailability";

export type AudioProcessorAvailabilityOptions = PluginCapabilityAvailabilityOptions;
export type AudioProcessorAvailabilityResolution = PluginCapabilityAvailabilityResolution;

export async function canOpenAudioProcessor(
  plugin: SystemSculptPlugin,
  options: AudioProcessorAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<boolean> {
  return (await getAudioProcessorAvailability(plugin, options, signal)).canOpen;
}

export function getAudioProcessorAvailability(
  plugin: SystemSculptPlugin,
  options: AudioProcessorAvailabilityOptions = {},
  signal?: AbortSignal,
): Promise<AudioProcessorAvailabilityResolution> {
  return getPluginCapabilityAvailability(plugin, "hosted_audio_processor", options, signal);
}
