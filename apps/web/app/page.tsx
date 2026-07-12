import { OneBetStage } from '@/components/bet';
import { Header } from '@/components/layout/Header';
import { ReloadButton } from '@/components/layout/ReloadButton';
import { BreadthRotationStage, CoreReadStage, MarketStage } from '@/components/market';
import { ScoreboardStage } from '@/components/scoreboard';
import { WatchlistWorkbench } from '@/components/watchlist';
import { getDashboard } from '@/lib/api';

// Live DB state — never statically cache this route.
export const dynamic = 'force-dynamic';

const MAIN_CLASS =
  'w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]';

interface PageProps {
  searchParams: Promise<{ run?: string }>;
}

function BareHeader() {
  return (
    <div className="flex items-start justify-between gap-4 mb-[18px]">
      <h1 className="m-0 text-base font-semibold uppercase tracking-wide leading-tight">
        Crypto Screener
      </h1>
      <ReloadButton />
    </div>
  );
}

/**
 * Top-down: the market first, then where money is moving, then the majors, and only then the
 * names the screen surfaced. Reading order IS the analysis — which is why there is no longer a
 * subtitle telling the user which section to start with.
 */
export default async function Page({ searchParams }: PageProps) {
  const { run } = await searchParams;
  const result = await getDashboard(run);

  // <Header> needs `freshness`, which only an 'ok' payload carries — so the failure branches fall
  // back to a bare title bar.
  if (!result.ok) {
    return (
      <main className={MAIN_CLASS}>
        <BareHeader />
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
        <BareHeader />
        <div className="panel">
          <div className="py-7 px-3 text-muted text-center">
            No screener runs yet. Refresh to collect the first one.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={MAIN_CLASS}>
      <Header
        freshness={payload.freshness}
        runs={payload.runs}
        selectedRunId={payload.run.run_id}
      />

      <MarketStage
        regime={payload.regime}
        marketContext={payload.market_context}
        validation={payload.validation}
        quality={payload.quality}
        providerStatus={payload.provider_status}
        run={payload.run}
        watchlists={payload.watchlists}
      />

      <BreadthRotationStage marketContext={payload.market_context} />

      <CoreReadStage rows={payload.sections.core} />

      {/* id is the sieve's scroll target — its final segment jumps here. */}
      <section id="screened-coins" className="stage" aria-labelledby="screened-coins-title">
        <p className="stage-eyebrow">What cleared the screen</p>
        <h2 id="screened-coins-title" className="stage-title mb-3">
          Screened coins
        </h2>
        <WatchlistWorkbench watchlists={payload.watchlists} />
      </section>

      <OneBetStage modelWeights={payload.model_weights} watchlists={payload.watchlists} />

      <ScoreboardStage scoreboard={payload.scoreboard} />
    </main>
  );
}
