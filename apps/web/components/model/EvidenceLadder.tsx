import { InfoTip } from '@/components/ui/Tooltip';
import { lookupMetric } from '@/lib/copy';
import type { EvidenceRung, RungStatus } from '@/lib/model-health';

export interface EvidenceLadderProps {
  rungs: EvidenceRung[];
}

const STATUS_LABEL: Record<RungStatus, string> = {
  pass: 'Yes',
  partial: 'Partly',
  fail: 'Not yet',
};

const STATUS_PILL_TONE: Record<RungStatus, string> = {
  pass: 'pos',
  partial: 'warn',
  fail: 'neutral',
};

/**
 * Which jargon term backs each rung's claim, so the reader can see the bar it's judged against.
 * "The data going in is clean" needs no tooltip -- it's already plain English with a concrete
 * detail sentence (N of M coins passed every check).
 */
const RUNG_TERM: Record<EvidenceRung['key'], string | null> = {
  clean_data: null,
  signals_measured: 'observations',
  measurements_strong: 'factor_net_spread',
  scored_end_to_end: 'calibration',
};

/**
 * The hero's signature element: four ascending claims the model would like to make about
 * itself, each lit only if the real numbers back it up. Source order is rung 1 (bottom) to rung
 * 4 (top) -- `.ladder`'s column-reverse flips that to the intuitive bottom-to-top read.
 */
export function EvidenceLadder({ rungs }: EvidenceLadderProps) {
  if (rungs.length === 0) return null;

  return (
    <ol className="ladder m-0 list-none p-0" aria-label="Evidence the model can trust itself">
      {rungs.map((rung, index) => {
        const termKey = RUNG_TERM[rung.key];
        const term = termKey ? lookupMetric(termKey) : null;
        return (
          <li key={rung.key} className={`ladder-rung ${rung.status}`}>
            <span className="ladder-rung-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="ladder-rung-body">
              <span className="ladder-rung-top">
                <span className="ladder-rung-claim">
                  {rung.claim}
                  {term ? <InfoTip term={rung.claim} definition={term.definition} /> : null}
                </span>
                <span className={`status-pill ${STATUS_PILL_TONE[rung.status]}`}>
                  {STATUS_LABEL[rung.status]}
                </span>
              </span>
              <span className="ladder-rung-detail">{rung.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
