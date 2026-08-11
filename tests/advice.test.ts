import { check, report } from "./_harness";
import { buildRiskAdvice } from "@/lib/journal/advice";
import type { TagStat } from "@/types/journal";

/**
 * 風控與停損建議 — the journal turned into instructions.
 *
 * The invariants: the baseline rules always appear (they don't depend on
 * history); a failure cause that never happened produces no advice (advice
 * about hypothetical mistakes is noise); the worst observed cause comes
 * first; and every automated claim marks whether it is actually live, so
 * "the system learned from this" is checkable.
 */

const stat = (tag: TagStat["tag"], count: number, avgSeverity: number): TagStat => ({
  tag,
  count,
  avgSeverity,
  cumulativeLossPct: -count * 1.1,
});

{
  const advice = buildRiskAdvice([], []);
  const baseline = advice.filter((a) => a.tag === null);
  check("the baseline rules stand without any history", baseline.length >= 3, baseline.length);
  check("and nothing tag-specific is invented", advice.length === baseline.length, advice);
  check("position sizing is one of them",
    baseline.some((a) => a.detail.includes("1–2%")), baseline.map((a) => a.title));
  check("never widening a stop is another",
    baseline.some((a) => a.title.includes("停損只進不退")), undefined);
}

{
  const recent = [stat("S1", 2, 2.5), stat("S3", 4, 3.6)];
  const active = [stat("S3", 4, 3.6)];
  const advice = buildRiskAdvice(recent, active);
  const tagged = advice.filter((a) => a.tag !== null);

  check("only observed causes get advice", tagged.length === 2, tagged.map((a) => a.tag));
  check("the most frequent cause comes first", tagged[0].tag === "S3", tagged[0].tag);

  const s3 = tagged.find((a) => a.tag === "S3")!;
  check("the advice names the behaviour, not just the tag",
    s3.detail.includes("停損"), s3.detail);
  check("the evidence is cited", s3.basedOn?.includes("4 次") === true, s3.basedOn);
  check("the automated tightening is stated", s3.automated?.includes("1.0×ATR") === true,
    s3.automated);
  check("and marked live because the intervention triggered", s3.active === true);

  const s1 = tagged.find((a) => a.tag === "S1")!;
  check("an untriggered cause is advice, not an active intervention",
    s1.active === false, s1);
}

{
  // S6 is a discipline problem — the engine deliberately has no knob for it,
  // and the advice must say the honest thing rather than invent an automation.
  const advice = buildRiskAdvice([stat("S6", 3, 3.5)], [stat("S6", 3, 3.5)]);
  const s6 = advice.find((a) => a.tag === "S6")!;
  check("S6 claims no automation", s6.automated === null, s6.automated);
}

report("risk advice");
