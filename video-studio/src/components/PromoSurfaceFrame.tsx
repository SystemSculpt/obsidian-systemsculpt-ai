import type { CSSProperties, PropsWithChildren } from "react";

const outerFrameStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  padding: 10,
  borderRadius: 28,
  background:
    "linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.4))",
  border: "1px solid rgba(255, 255, 255, 0.82)",
  boxShadow:
    "0 28px 70px rgba(15, 23, 42, 0.18), 0 14px 32px rgba(15, 23, 42, 0.1)",
  overflow: "hidden",
};

const innerFrameStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  borderRadius: 20,
  overflow: "hidden",
  background: "#161616",
};

const frameSheenStyle: CSSProperties = {
  position: "absolute",
  inset: 1,
  borderRadius: 27,
  background:
    "linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0) 28%)",
  pointerEvents: "none",
};

export const PromoSurfaceFrame: React.FC<PropsWithChildren> = ({ children }) => {
  return (
    <div style={outerFrameStyle}>
      <div style={frameSheenStyle} />
      <div style={innerFrameStyle}>{children}</div>
    </div>
  );
};
