import { listCourses } from "@/app/lib/courseStore";
import { LearnHydrator } from "../../LearnHydrator";
import { LearnStaticView } from "../../LearnStaticView";

type LearnCoursePageProps = {
  params: Promise<{
    courseId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LearnCoursePage({
  params,
}: LearnCoursePageProps) {
  const { courseId } = await params;
  const courses = await listCourses();

  return (
    <>
      <LearnStaticView initialCourses={courses.slice(0, 6)} />
      <LearnHydrator initialCourseId={courseId} />
    </>
  );
}
