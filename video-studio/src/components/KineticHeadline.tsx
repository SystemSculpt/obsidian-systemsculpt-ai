import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

interface KineticHeadlineProps {
  kicker?: string;
  lines: readonly string[];
  accentLineIndex?: number;
  accentColor: string;
  align?: "left" | "center";
}

export const KineticHeadline: React.FC<KineticHeadlineProps> = ({
  kicker,
  lines,
  accentLineIndex = -1,
  accentColor,
  align = "left",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        alignItems: align === "center" ? "center" : "flex-start",
        textAlign: align,
      }}
    >
      {kicker ? (
        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(18, 20, 23, 0.54)",
          }}
        >
          {kicker}
        </div>
      ) : null}
      {lines.map((line, lineIndex) => {
        const lineProgress = spring({
          fps,
          frame: frame - lineIndex * 8,
          config: {
            damping: 18,
            stiffness: 150,
            mass: 0.75,
          },
        });
        const words = line.split(" ");

        return (
          <div
            key={`${line}-${lineIndex}`}
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              gap: 18,
              alignItems: "center",
              justifyContent: align === "center" ? "center" : "flex-start",
              padding:
                accentLineIndex === lineIndex ? "10px 18px 14px 18px" : 0,
              borderRadius: accentLineIndex === lineIndex ? 28 : 0,
              background:
                accentLineIndex === lineIndex ? accentColor : "transparent",
              boxShadow:
                accentLineIndex === lineIndex
                  ? "0 18px 54px rgba(18, 20, 23, 0.12)"
                  : "none",
              transform: `translateY(${interpolate(
                lineProgress,
                [0, 1],
                [28, 0]
              )}px)`,
              opacity: lineProgress,
            }}
          >
            {words.map((word, wordIndex) => {
              const wordProgress = spring({
                fps,
                frame: frame - lineIndex * 8 - wordIndex * 3,
                config: {
                  damping: 20,
                  stiffness: 190,
                  mass: 0.7,
                },
              });

              return (
                <span
                  key={`${word}-${wordIndex}`}
                  style={{
                    display: "inline-block",
                    fontSize: 96,
                    fontWeight: 800,
                    lineHeight: 0.92,
                    letterSpacing: "-0.05em",
                    color:
                      accentLineIndex === lineIndex ? "#FFFFFF" : "#121417",
                    transform: `translateY(${interpolate(
                      wordProgress,
                      [0, 1],
                      [34, 0]
                    )}px) scale(${interpolate(wordProgress, [0, 1], [0.92, 1])})`,
                    opacity: wordProgress,
                  }}
                >
                  {word}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
