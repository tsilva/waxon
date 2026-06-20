import { AppStaticLoadingView } from "../AppStaticLoadingView";
import { ReviewHydrator } from "./ReviewHydrator";

export default function ReviewPage() {
  return (
    <>
      <AppStaticLoadingView staticView="review" />
      <ReviewHydrator />
    </>
  );
}
