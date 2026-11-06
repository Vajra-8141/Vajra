import { EvidenceBook } from "../components/evidence-book";
import { loadEvidence } from "../lib/evidence";

export default function RecordPage() {
  const records = loadEvidence();
  const newest = records.flatMap((r) => (r.at ? [r.at] : [])).sort().at(-1);
  return (
    <div className="stack">
      <div className="hero small">
        <h1>The recorded runs</h1>
        <p className="lead">A read-only copy of <code>docs/evidence/</code>. Nothing on this page is live: it has no wallet and no bridge, and it reads no chain. A hash shown here was not checked when this page was built.</p>
        <p className="sub">
          {records.length} records, the newest from {newest ? new Date(newest).toUTCString() : "an unknown date"}. To run it yourself, clone the repository and run <code>make judge</code>.
        </p>
      </div>
      <EvidenceBook records={records} />
    </div>
  );
}
