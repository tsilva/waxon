import { AppStaticLoadingView } from "../AppStaticLoadingView";
import { LibraryHydrator } from "./LibraryHydrator";

export default function LibraryPage() {
  return (
    <>
      <AppStaticLoadingView staticView="library" />
      <LibraryHydrator />
    </>
  );
}
