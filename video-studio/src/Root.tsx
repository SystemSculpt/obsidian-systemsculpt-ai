import { Composition } from "remotion";
import { PromoStoryboardComposition } from "./components/PromoStoryboardComposition";
import { storyboardCatalog } from "./data/storyboardCatalog";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {storyboardCatalog.map(({ id, storyboard }) => (
        <Composition
          key={id}
          id={id}
          component={PromoStoryboardComposition}
          durationInFrames={storyboard.durationInFrames}
          fps={storyboard.fps}
          width={storyboard.width}
          height={storyboard.height}
          defaultProps={{
            storyboard,
          }}
        />
      ))}
    </>
  );
};
