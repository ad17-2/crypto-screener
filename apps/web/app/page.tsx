import { Header } from '@/components/layout/Header';
import { ReloadButton } from '@/components/layout/ReloadButton';
import { BreadthRotationStage, CoreReadStage, MarketStage } from '@/components/market';
import { WatchlistWorkbench } from '@/components/watchlist';
import { getDashboard } from '@/lib/api';
import { btcRunPrice } from '@/lib/btc-pulse';

// Live DB state — never statically cache this route.
export const dynamic = 'force-dynamic';

const MAIN_CLASS = 'max-w-[64rem] mx-auto px-6 pt-16 max-[680px]:pt-10 pb-24';

interface PageProps {
  searchParams: Promise<{ run?: string }>;
}

function BareHeader() {
  return (
    <div className="flex items-start justify-between gap-4 mb-10">
      <h1 className="m-0 text-lg font-bold text-ink">Crypto Screener</h1>
      <ReloadButton />
    </div>
  );
}

/**
 * Top-down: the market first, then where money is moving, then the majors, and only then the
 * names the screen surfaced. Reading order IS the analysis.
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

  const screenedWatchlists = payload.watchlists.filter((list) => list.id !== 'core');

  return (
    <main className={MAIN_CLASS}>
      <Header
        freshness={payload.freshness}
        runs={payload.runs}
        selectedRunId={payload.run.run_id}
        refreshStatus={payload.refresh_status}
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
        <WatchlistWorkbench
          watchlists={screenedWatchlists}
          runBtcPrice={btcRunPrice(payload.sections.core)}
          watchlistChanges={payload.watchlist_changes}
        />
      </section>
    </main>
  );
}
