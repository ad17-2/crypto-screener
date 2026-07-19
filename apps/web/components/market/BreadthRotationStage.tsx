import { InfoTip } from '@/components/ui/Tooltip';
import { lookupBreadthLabel, lookupSectorRotationLabel } from '@/lib/copy';
import { clsFor } from '@/lib/format';
import { arr, num, pct, rec, signedPct, str } from '@/lib/payload';

export interface BreadthRotationStageProps {
  marketContext: unknown;
}

interface CategoryItem {
  id: string;
  name: string;
  changePct: number | null;
}

const MAX_CATEGORY_ROWS = 4;

export function BreadthRotationStage({ marketContext }: BreadthRotationStageProps) {
  const breadth = rec(marketContext, 'breadth');
  const advancers = num(breadth, 'advancers');
  const decliners = num(breadth, 'decliners');
  const sampleSize = num(breadth, 'sample_size');
  const advancerPct = num(breadth, 'advancer_pct');
  const declinerPct = num(breadth, 'decliner_pct');
  const breadthEntry = lookupBreadthLabel(str(breadth, 'label'));
  const rawBreadthLabel = str(breadth, 'label');

  const rotation = rec(marketContext, 'sector_rotation');
  const rotationEntry = lookupSectorRotationLabel(str(rotation, 'label'));
  const rawRotationLabel = str(rotation, 'label');
  const leaderAvg = num(rotation, 'leader_avg_24h_pct');
  const laggardAvg = num(rotation, 'laggard_avg_24h_pct');
  const spread = num(rotation, 'leader_laggard_spread_pct');

  const categories = rec(marketContext, 'categories');
  const leaders = categoryItems(arr(categories, 'leaders')).slice(0, MAX_CATEGORY_ROWS);
  const laggards = categoryItems(arr(categories, 'laggards')).slice(0, MAX_CATEGORY_ROWS);

  return (
    <section className="stage" aria-label="Breadth and rotation">
      <h2 className="stage-eyebrow m-0">Breadth &amp; rotation</h2>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="stage-title m-0">{breadthEntry.label}</h3>
            <InfoTip
              term={breadthEntry.label}
              definition={`${breadthEntry.definition} Raw label: "${rawBreadthLabel ?? 'unknown'}".`}
            />
          </div>
          <div className="mt-4 breadth-bar" aria-hidden="true">
            <span className="breadth-up" style={{ width: `${advancerPct ?? 0}%` }} />
            <span className="breadth-down" style={{ width: `${declinerPct ?? 0}%` }} />
          </div>
          <p className="mt-2 text-[13px] text-ink">
            {advancers ?? '—'} up · {decliners ?? '—'} down of {sampleSize ?? '—'}
          </p>
        </div>

        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="stage-title m-0">{rotationEntry.label}</h3>
            <InfoTip
              term={rotationEntry.label}
              definition={`${rotationEntry.definition} Raw label: "${rawRotationLabel ?? 'unknown'}".`}
            />
          </div>
          {leaderAvg !== null && laggardAvg !== null && spread !== null ? (
            <p className="mt-2 text-[13px] text-muted">
              Leaders averaging {signedPct(leaderAvg, 1)}, laggards {signedPct(laggardAvg, 1)} — a
              spread of {pct(spread, 1)}.
            </p>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-6">
            <CategoryList title="Leaders" items={leaders} />
            <CategoryList title="Laggards" items={laggards} />
          </div>
        </div>
      </div>
    </section>
  );
}

function CategoryList({ title, items }: { title: string; items: CategoryItem[] }) {
  return (
    <div className="min-w-0">
      <div className="label">{title}</div>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">None reported.</p>
      ) : (
        <ul className="mt-2 grid list-none gap-1.5 p-0">
          {items.map((item) => (
            <li key={item.id} className="min-w-0 flex items-baseline gap-2 text-[13px]">
              <span className="select-none text-ash" aria-hidden="true">
                –
              </span>
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
              </span>
              <span className={`shrink-0 font-mono ${clsFor(item.changePct)}`}>
                {signedPct(item.changePct, 1)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function categoryItems(entries: unknown[]): CategoryItem[] {
  return entries.map((entry, index) => {
    const id = str(entry, 'id');
    const name = str(entry, 'name') ?? id ?? `category-${index}`;
    return { id: id ?? name, name, changePct: num(entry, 'market_cap_change_24h_pct') };
  });
}
