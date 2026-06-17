import { LibraryHydrator } from "./LibraryHydrator";
import { LibraryStaticView } from "./LibraryStaticView";

export default function LibraryPage() {
  return (
    <>
      <LibraryStaticView />
      <LibraryHydrator />
    </>
  );
}
