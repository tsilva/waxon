import { LearnCoursesHydrator } from "./LearnCoursesHydrator";
import { AppStaticLoadingView } from "../AppStaticLoadingView";

export default function LearnPage() {
  return (
    <>
      <AppStaticLoadingView staticView="learn" />
      <LearnCoursesHydrator />
    </>
  );
}
