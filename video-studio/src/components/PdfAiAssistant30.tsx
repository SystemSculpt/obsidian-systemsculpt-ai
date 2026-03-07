import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { KineticHeadline } from "./KineticHeadline";
import { SystemSculptSurface } from "./SystemSculptSurface";
import { getSceneOffsets, type SceneSpec, type Storyboard } from "../lib/storyboard";
import { pdfAiAssistantStoryboard } from "../data/pdfAiAssistantStoryboard";

const fontStack =
  '"SF Pro Display", "Inter Tight", "Inter", "Helvetica Neue", Arial, sans-serif';

const containSize = (
  boxWidth: number,
  boxHeight: number,
  aspectRatio: number
): { width: number; height: number } => {
  if (boxWidth <= 0 || boxHeight <= 0 || aspectRatio <= 0) {
    return { width: 0, height: 0 };
  }

  const boxAspect = boxWidth / boxHeight;
  if (boxAspect > aspectRatio) {
    return {
      width: Math.round(boxHeight * aspectRatio),
      height: Math.round(boxHeight),
    };
  }

  return {
    width: Math.round(boxWidth),
    height: Math.round(boxWidth / aspectRatio),
  };
};

const getSurfaceAspectRatio = (scene: SceneSpec): number => {
  switch (scene.surface.kind) {
    case "context-modal":
      return 1.36;
    case "chat-status":
      return 1.58;
    case "chat-thread":
      return scene.layout === "center-lockup" ? 1.5 : 1.68;
  }
};

const getSurfaceSize = (
  scene: SceneSpec,
  width: number,
  height: number
): { width: number; height: number } => {
  const isCenterLockup = scene.layout === "center-lockup";
  const boxWidth = isCenterLockup
    ? Math.min(width * 0.68, 1280)
    : Math.min(width * 0.47, 920);
  const boxHeight = isCenterLockup
    ? Math.min(height * 0.56, 610)
    : Math.min(height * 0.5, 540);

  return containSize(boxWidth, boxHeight, getSurfaceAspectRatio(scene));
};

const SupportingCopy: React.FC<{ text?: string; align?: "left" | "center" }> = ({
  text,
  align = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    fps,
    frame: frame - 18,
    config: {
      damping: 18,
      stiffness: 120,
      mass: 0.9,
    },
  });

  if (!text) {
    return null;
  }

  return (
    <div
      style={{
        maxWidth: 560,
        marginTop: 24,
        fontSize: 28,
        lineHeight: 1.35,
        letterSpacing: "-0.03em",
        color: "rgba(18, 20, 23, 0.72)",
        textAlign: align,
        transform: `translateY(${interpolate(progress, [0, 1], [18, 0])}px)`,
        opacity: progress,
      }}
    >
      {text}
    </div>
  );
};

const SceneComposition: React.FC<{
  scene: SceneSpec;
}> = ({ scene }) => {
  const { width, height } = useVideoConfig();
  const surfaceSize = getSurfaceSize(scene, width, height);
  const media = (
    <div
      style={{
        position: "relative",
        width: surfaceSize.width,
        height: surfaceSize.height,
        maxWidth: "100%",
        maxHeight: "100%",
        flex: "0 0 auto",
      }}
    >
      <SystemSculptSurface scene={scene} />
    </div>
  );

  if (scene.layout === "center-lockup") {
    return (
      <AbsoluteFill
        style={{
          fontFamily: fontStack,
          background: `linear-gradient(140deg, ${scene.background[0]}, ${scene.background[1]})`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at top left, rgba(255,255,255,0.52), rgba(255,255,255,0) 42%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: "52px 72px 60px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 28,
          }}
        >
          <div
            style={{
              marginTop: 4,
              flex: "0 0 auto",
            }}
          >
            <KineticHeadline
              kicker={scene.kicker}
              lines={scene.headlineLines}
              accentLineIndex={scene.accentLineIndex}
              accentColor={scene.accentColor}
              align="center"
            />
            <SupportingCopy text={scene.supportingText} align="center" />
          </div>
          <div
            style={{
              position: "relative",
              flex: 1,
              width: "100%",
              minHeight: 0,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
            }}
          >
            {media}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  const isLeft = scene.layout === "split-left";

  return (
    <AbsoluteFill
        style={{
          fontFamily: fontStack,
          background: `linear-gradient(145deg, ${scene.background[0]}, ${scene.background[1]})`,
        }}
      >
      <div
        style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at top left, rgba(255,255,255,0.52), rgba(255,255,255,0) 42%)",
          }}
        />
      <div
        style={{
          position: "absolute",
          inset: "64px 72px 60px 72px",
          display: "grid",
          gridTemplateColumns: isLeft ? "0.95fr 1.05fr" : "1.05fr 0.95fr",
          gap: 40,
          alignItems: "center",
        }}
      >
        <div
          style={{
            order: isLeft ? 0 : 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <KineticHeadline
            kicker={scene.kicker}
            lines={scene.headlineLines}
            accentLineIndex={scene.accentLineIndex}
            accentColor={scene.accentColor}
          />
          <SupportingCopy text={scene.supportingText} />
        </div>
        <div
          style={{
            order: isLeft ? 1 : 0,
            justifySelf: "stretch",
            alignSelf: "stretch",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {media}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const PdfAiAssistant30: React.FC<{
  storyboard?: Storyboard;
}> = ({ storyboard = pdfAiAssistantStoryboard }) => {
  const offsets = getSceneOffsets(storyboard.scenes);

  return (
    <AbsoluteFill style={{ background: "#F5F4EF" }}>
      {offsets.map(({ scene, from }) => (
        <Sequence
          key={scene.id}
          from={from}
          durationInFrames={scene.durationInFrames}
        >
          <SceneComposition scene={scene} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
