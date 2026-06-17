import { LearnHydrator } from "../../LearnHydrator";
import { LearnStaticView } from "../../LearnStaticView";

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
      <LearnStaticView />
      <LearnHydrator initialCourseId={courseId} />
    </>
  );
}
