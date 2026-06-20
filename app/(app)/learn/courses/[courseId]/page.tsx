import { LearnHydrator } from "../../LearnHydrator";
import { AppStaticLoadingView } from "../../../AppStaticLoadingView";

type LearnCoursePageProps = {
  params: Promise<{
    courseId: string;
  }>;
};

export default async function LearnCoursePage({
  params,
}: LearnCoursePageProps) {
  const { courseId } = await params;

  return (
    <>
      <AppStaticLoadingView staticView="learn" />
      <LearnHydrator initialCourseId={courseId} />
    </>
  );
}
