import Link from 'next/link';
import {
  DataQualityPanel,
  FactorWeightsPanel,
  FreshnessPanel,
  ProvidersPanel,
  ValidationPanel,
} from '@/components/context';
import { getDashboard } from '@/lib/api';

// Live DB state — never statically cache this route.
export const dynamic = 'force-dynamic';

export default async function ModelPage() {
  const result = await getDashboard();

  if (!result.ok) {
    return (
      <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
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
      <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
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
    <main className="w-[min(1480px,calc(100vw-32px))] max-[680px]:w-[min(100vw-20px,1480px)] mx-auto pt-[22px] max-[680px]:pt-3.5 pb-[34px]">
      <PageHeader />
      <section className="module-grid" aria-label="Model health">
        <ValidationPanel validation={payload.validation} />
        <FactorWeightsPanel modelWeights={payload.model_weights} />
        <ProvidersPanel providerStatus={payload.provider_status} />
        <DataQualityPanel quality={payload.quality} />
        <FreshnessPanel freshness={payload.freshness} runs={payload.runs} />
      </section>
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
          How the model is weighting factors right now, how well it's calibrated, and whether the
          data feeding it is clean.
        </div>
      </div>
      <Link href="/" className="text-muted text-[13px] whitespace-nowrap hover:text-ink">
        ← Dashboard
      </Link>
    </div>
  );
}
