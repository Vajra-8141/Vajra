import { Story } from "../../components/story";
import { threadFacts } from "../../components/thread-facts";

export default function StoryPage() {
  return <Story facts={threadFacts()} />;
}
