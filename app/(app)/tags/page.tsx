import { TagsHydrator } from "./TagsHydrator";
import { TagsStaticView } from "./TagsStaticView";

export default function TagsPage() {
  return (
    <>
      <TagsStaticView />
      <TagsHydrator />
    </>
  );
}
