import { Composition } from "remotion";
import { PdfAiAssistant30 } from "./components/PdfAiAssistant30";
import { pdfAiAssistantStoryboard } from "./data/pdfAiAssistantStoryboard";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PdfAiAssistant30"
        component={PdfAiAssistant30}
        durationInFrames={pdfAiAssistantStoryboard.durationInFrames}
        fps={pdfAiAssistantStoryboard.fps}
        width={pdfAiAssistantStoryboard.width}
        height={pdfAiAssistantStoryboard.height}
        defaultProps={{
          storyboard: pdfAiAssistantStoryboard,
        }}
      />
    </>
  );
};
