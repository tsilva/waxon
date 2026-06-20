import { LearnHydrator } from "./LearnHydrator";
import { AppStaticLoadingView } from "../AppStaticLoadingView";

export default function LearnPage() {
  return (
    <>
      <AppStaticLoadingView staticView="learn" />
      <LearnHydrator />
    </>
  );
}
