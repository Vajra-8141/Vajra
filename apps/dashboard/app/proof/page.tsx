import { EvidenceBook } from "../../components/evidence-book";
import { LiveCheck, LiveTag } from "../../components/live-tag";
import { loadEvidence } from "../../lib/evidence";

export default function ProofPage() {
  const records = loadEvidence();
  const hashes = records.filter((r) => r.origin === "public").flatMap((r) => r.transactions.map((t) => t.hash));
  return (
    <div className="stack">
      <div className="hero small">
        <h1>What the chain actually did</h1>
        <p className="lead">Every line here comes from a recorded run in <code>docs/evidence/</code>, and each record says where it ran. Reproduce any of it with the command beside it.</p>
      </div>
      <LiveCheck hashes={hashes}>
        <EvidenceBook records={records} Live={LiveTag} />
      </LiveCheck>
    </div>
  );
}
