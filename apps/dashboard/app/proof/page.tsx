import { EvidenceBook } from "../../components/evidence-book";
import { LiveCheck, LiveTag } from "../../components/live-tag";
import { NextStep, PageHead } from "../../components/thread";
import { loadEvidence } from "../../lib/evidence";

export default function ProofPage() {
  const records = loadEvidence();
  const hashes = records.filter((r) => r.origin === "public").flatMap((r) => r.transactions.map((t) => t.hash));
  return (
    <div className="stack">
      <PageHead because="every moment, recorded" title="What the chain actually did">
        Every line here comes from a recorded run in <code>docs/evidence/</code>, and each record says where it ran. Reproduce any of it with the command beside it.
      </PageHead>
      <LiveCheck hashes={hashes}>
        <EvidenceBook records={records} Live={LiveTag} />
      </LiveCheck>
      <NextStep href="/scanner" label="Is your own key already exposed?" why="Why the master key is made of hashes, checked against your address on mainnet." />
    </div>
  );
}
