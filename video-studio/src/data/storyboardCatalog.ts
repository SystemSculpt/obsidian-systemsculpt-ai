import type { Storyboard } from "../lib/storyboard";
import { systemSculptOverviewStoryboard } from "./systemSculptOverviewStoryboard";

export interface StoryboardCompositionSpec {
  id: string;
  storyboard: Storyboard;
}

export const storyboardCatalog: readonly StoryboardCompositionSpec[] = [
  {
    id: "SystemSculptOverview30",
    storyboard: systemSculptOverviewStoryboard,
  },
];
