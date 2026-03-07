import { useLayoutEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { SceneSpec } from "../lib/storyboard";
import { ensureObsidianDomCompat } from "../shims/domCompat";
import {
  hostControlCss,
  leafContentStyle,
  obsidianThemeStyle,
  overlayMountStyle,
  viewContentStyle,
  workspaceStyle,
} from "./system-sculpt-surface/hostStyles";
import {
  mountSceneSurface,
  type SurfaceMountController,
} from "./system-sculpt-surface/surfaceMounts";
import { getViewChrome, mountViewHeader } from "./system-sculpt-surface/viewChrome";

ensureObsidianDomCompat();

const frameDrivenSurfaceKinds = new Set<SceneSpec["surface"]["kind"]>([
  "search-modal",
  "context-modal",
  "chat-thread",
] as const);

const getSurfaceDataType = (scene: SceneSpec): string => {
  switch (scene.surface.kind) {
    case "bench-results-view":
      return "systemsculpt-bench-results-view";
    case "settings-panel":
      return "systemsculpt-settings-view";
    case "studio-graph-view":
      return "systemsculpt-studio-view";
    default:
      return "systemsculpt-chat-view";
  }
};

export const SystemSculptSurface: React.FC<{
  scene: SceneSpec;
}> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceControllerRef = useRef<SurfaceMountController | null>(null);
  const mountedSceneIdRef = useRef<string | null>(null);
  const lastRenderedFrameRef = useRef<number | null>(null);
  const chrome = getViewChrome(scene);
  const dataType = getSurfaceDataType(scene);
  const isFrameDrivenSurface = frameDrivenSurfaceKinds.has(scene.surface.kind);

  const cleanupSurface = () => {
    surfaceControllerRef.current?.cleanup?.();
    surfaceControllerRef.current = null;
  };

  const renderSurface = (targetFrame: number) => {
    const header = headerRef.current;
    const content = contentRef.current;
    const overlay = overlayRef.current;
    if (!header || !content || !overlay) {
      return;
    }

    mountViewHeader(header, chrome);
    cleanupSurface();
    overlay.remove();
    content.empty();
    overlay.empty();

    surfaceControllerRef.current =
      mountSceneSurface({
        contentRoot: content,
        overlayRoot: overlay,
        scene,
        chrome,
        frame: targetFrame,
        fps,
      }) ?? null;

    content.appendChild(overlay);
    mountedSceneIdRef.current = scene.id;
    lastRenderedFrameRef.current = targetFrame;
  };

  useLayoutEffect(() => {
    renderSurface(frame);

    return () => {
      cleanupSurface();
      mountedSceneIdRef.current = null;
      lastRenderedFrameRef.current = null;
    };
  }, [dataType, fps, scene.id]);

  useLayoutEffect(() => {
    if (!isFrameDrivenSurface) {
      return;
    }

    if (mountedSceneIdRef.current !== scene.id || lastRenderedFrameRef.current === frame) {
      return;
    }

    const content = contentRef.current;
    const overlay = overlayRef.current;
    if (!content || !overlay) {
      return;
    }

    const controller = surfaceControllerRef.current;
    if (controller?.update) {
      controller.update({
        contentRoot: content,
        overlayRoot: overlay,
        chrome,
        frame,
        fps,
        surface: scene.surface as never,
      });
      lastRenderedFrameRef.current = frame;
      return;
    }

    renderSurface(frame);
  }, [chrome, fps, frame, isFrameDrivenSurface, scene.id, scene.surface]);

  return (
    <div style={{ ...obsidianThemeStyle, width: "100%", height: "100%" }}>
      <style>{hostControlCss}</style>
      <div style={workspaceStyle}>
        <div className="workspace-split mod-root" style={{ width: "100%", height: "100%" }}>
          <div className="workspace-leaf mod-active" style={{ width: "100%", height: "100%" }}>
            <div
              className="workspace-leaf-content systemsculpt-video-host"
              data-type={dataType}
              style={leafContentStyle}
            >
              <div ref={headerRef} className="view-header" />
              <div
                ref={contentRef}
                className="view-content systemsculpt-chat-container systemsculpt-reduced-motion"
                style={viewContentStyle}
              >
                <div ref={overlayRef} style={overlayMountStyle} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
