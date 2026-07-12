import Link from 'next/link';
import { DataInStage, HeroStage } from '@/components/model';
import { ScoreboardStage } from '@/components/scoreboard';
import { getDashboard } from '@/lib/api';

// Live DB state — never statically cache this route.
export const dynamic = 'force-dynamic';

// Narrower than the dashboard's 1480px on purpose: this page is read top-to-bottom like a document,
// not scanned like a grid. At 1480 its prose keeps its ~65ch measure and strands half the viewport empty.
const MAIN_CLASS =
  'w-[min(1120px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1120px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]';

export default async function ModelPage() {
  const result = await getDashboard();

  if (!result.ok) {
    return (
      <main className={MAIN_CLASS}>
        <PageHeader />
        <div className="panel">
          <div className="py-7 px-3 text-down text-center">Dashboard error: {result.error}</div>
        </div>
      </main>
    );
  }

  const { payload } = result;

  if (payload.status === 'empty') {
    return (
      <main className={MAIN_CLASS}>
        <PageHeader />
        <div className="panel">
          <div className="py-7 px-3 text-muted text-center">
            No data in database: {payload.database}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={MAIN_CLASS}>
      <PageHeader />

      <HeroStage
        quality={payload.quality}
        validation={payload.validation}
        modelWeights={payload.model_weights}
      />

      <DataInStage
        providerStatus={payload.provider_status}
        quality={payload.quality}
        freshness={payload.freshness}
        run={payload.run}
      />

      <ScoreboardStage scoreboard={payload.scoreboard} />
    </main>
  );
}

function PageHeader() {
  return (
    <div className="flex items-start justify-between gap-4 mb-[18px] max-[680px]:flex-col max-[680px]:items-stretch">
      <div>
        <h1 className="m-0 text-base font-semibold uppercase tracking-wide leading-tight">
          Model health
        </h1>
        <div className="text-muted text-[13px] mt-1.5">
          Two questions: is there a validated edge right now, and what does the track record say.
        </div>
      </div>
      <Link href="/" className="text-muted text-[13px] whitespace-nowrap hover:text-ink">
        ← Dashboard
      </Link>
    </div>
  );
}
