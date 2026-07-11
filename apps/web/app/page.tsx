import {
  DataQualityPanel,
  FactorWeightsPanel,
  FreshnessPanel,
  ProvidersPanel,
  SectorRotationPanel,
  ValidationPanel,
} from '@/components/context';
import { Header } from '@/components/layout/Header';
import { ReloadButton } from '@/components/layout/ReloadButton';
import { StatusStrip } from '@/components/layout/StatusStrip';
import { WatchlistWorkbench } from '@/components/watchlist';
import { getDashboard } from '@/lib/api';

// Live DB state — never statically cache this route.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ run?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const { run } = await searchParams;
  const result = await getDashboard(run);

  if (!result.ok) {
    return (
      <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
        <div className="flex items-start justify-between gap-4 mb-[18px]">
          <h1 className="m-0 text-base font-semibold uppercase tracking-wide leading-tight">
            Crypto Dashboard
          </h1>
          <ReloadButton />
        </div>
        <div className="panel">
          <div className="py-7 px-3 text-down text-center">Dashboard error: {result.error}</div>
        </div>
      </main>
    );
  }

  const { payload } = result;

  if (payload.status === 'empty') {
    return (
      <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
        <Header subtitle="No saved screener runs" runs={payload.runs} />
        <div className="panel">
          <div className="py-7 px-3 text-muted text-center">
            No data in database: {payload.database}
          </div>
        </div>
      </main>
    );
  }

  const subtitle = `${payload.run.generated_at} / ${payload.run.row_count} symbols · Use Top Setups first -> filter -> inspect detail -> open TradingView. Freshness: ${payload.freshness.label || 'unknown'}.`;

  return (
    <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
      <Header subtitle={subtitle} runs={payload.runs} selectedRunId={payload.run.run_id} />
      <StatusStrip
        freshness={payload.freshness}
        quality={payload.quality}
        regime={payload.regime}
        marketContext={payload.market_context}
        providerStatus={payload.provider_status}
      />
      <WatchlistWorkbench watchlists={payload.watchlists} />
      <section className="module-grid" aria-label="Dashboard context">
        <ProvidersPanel providerStatus={payload.provider_status} />
        <DataQualityPanel quality={payload.quality} />
        <ValidationPanel validation={payload.validation} />
        <FactorWeightsPanel modelWeights={payload.model_weights} />
        <FreshnessPanel freshness={payload.freshness} runs={payload.runs} />
        <SectorRotationPanel marketContext={payload.market_context} />
      </section>
    </main>
  );
}
