import { Landing } from "../components/landing/landing";
import { threadFacts } from "../components/thread-facts";

export default function HomePage() {
  return <Landing facts={threadFacts()} />;
}
