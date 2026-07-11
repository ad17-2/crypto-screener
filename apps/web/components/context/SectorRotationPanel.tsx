import { Panel } from '@/components/layout/Panel';
import { clsFor, fmtNum, fmtPct } from '@/lib/format';
import { asRecord } from '@/lib/wire';
import { Row } from './Row';

export interface SectorRotationPanelProps {
  /** untyped on the wire — read defensively. */
  marketContext: Record<string, unknown>;
}

interface CategoryItem {
  id: string;
  name: string;
  changePct: unknown;
}

export function SectorRotationPanel({ marketContext }: SectorRotationPanelProps) {
  const breadth = asRecord(marketContext.breadth);
  const rotation = asRecord(marketContext.sector_rotation);
  const categories = asRecord(marketContext.categories);
  const leaders = asCategoryItems(categories.leaders).slice(0, 3);
  const laggards = asCategoryItems(categories.laggards).slice(0, 3);
  const label = typeof rotation.label === 'string' ? rotation.label : 'leaders / laggards';

  return (
    <Panel title="Sector Rotation" meta={label} accent="gold">
      <div className="sector-list list p-3 grid gap-2">
        <Row
          label="Breadth"
          value={`${typeof breadth.label === 'string' ? breadth.label : 'unknown'} / ${fmtNum(breadth.score, 2)}`}
        />
        <Row
          label="Sector Tape"
          value={typeof rotation.label === 'string' ? rotation.label : 'unknown'}
        />
        <div className="label">Leaders</div>
        {leaders.length === 0 ? (
          <div className="py-7 px-3 text-muted text-center">No leaders</div>
        ) : (
          leaders.map((item) => <CategoryRow key={`leader-${item.id}`} item={item} />)
        )}
        <div className="label">Laggards</div>
        {laggards.length === 0 ? (
          <div className="py-7 px-3 text-muted text-center">No laggards</div>
        ) : (
          laggards.map((item) => <CategoryRow key={`laggard-${item.id}`} item={item} />)
        )}
      </div>
    </Panel>
  );
}

function CategoryRow({ item }: { item: CategoryItem }) {
  return (
    <div className="list-row flex justify-between gap-3 text-[13px]">
      <strong>{item.name}</strong>
      <span className={clsFor(item.changePct)}>{fmtPct(item.changePct)}</span>
    </div>
  );
}

function asCategoryItems(value: unknown): CategoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    const name = typeof record.name === 'string' ? record.name : (id ?? '-');
    return [{ id: id ?? name, name, changePct: record.market_cap_change_24h_pct }];
  });
}
