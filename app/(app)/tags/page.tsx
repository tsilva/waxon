import { AppStaticLoadingView } from "../AppStaticLoadingView";
import { TagsHydrator } from "./TagsHydrator";

export default function TagsPage() {
  return (
    <>
      <AppStaticLoadingView staticView="tags" />
      <TagsHydrator />
    </>
  );
}
