import { App } from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  QuickEditController,
} from "./controller";
import { evaluateQuickEditReadiness } from "./capabilities";

export interface QuickEditRuntime {
  controller: QuickEditController;
}

export function createQuickEditRuntime(app: App, plugin: SystemSculptPlugin): QuickEditRuntime {
  void app;
  const controller = new QuickEditController({
    capabilityChecker: (input) => evaluateQuickEditReadiness(input),
  });
  return { controller };
}
