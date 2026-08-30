import { useEffect, useMemo, useState } from 'react';

type DemoState = {
  phase:
    | 'healthy'
    | 'detected'
    | 'investigating'
    | 'decision'
    | 'approval'
    | 'executing'
    | 'recovered'
    | 'failed';
  incidentId: string;
  sessionId?: string;
  detectedAt?: string;
  slackStatus?: 'pending' | 'delivered' | 'failed';
  slackPermalink?: string;
  message?: string;
};

type Sample = {
  requests: number;
  p99: number;
  errors: number;
  saturation: number;
};

const healthySample = (tick: number): Sample => ({
  requests: 1760 + Math.round(Math.sin(tick / 2.4) * 85 + Math.cos(tick / 5) * 42),
  p99: 78 + Math.round(Math.sin(tick / 3) * 7),
  errors: Math.max(0.04, 0.08 + Math.sin(tick / 4) * 0.025),
  saturation: 41 + Math.round(Math.cos(tick / 3.7) * 5),
});

const incidentSample = (tick: number): Sample => ({
  requests: 1580 + Math.round(Math.sin(tick) * 45),
  p99: 6450 + Math.round(Math.sin(tick / 1.8) * 365),
  errors: 11.6 + Math.sin(tick / 2.2) * 0.7,
  saturation: 94 + Math.round(Math.sin(tick / 3) * 3),
});

function sparkline(values: number[], width = 560, height = 120): string {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || 1;
  return values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - ((value - minimum) / spread) * (height - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function MetricChart({
  label,
  value,
  unit,
  values,
  danger,
}: {
  label: string;
  value: string;
  unit: string;
  values: number[];
  danger: boolean;
}) {
  return (
    <article className="production-metric" data-danger={danger || undefined}>
      <header>
        <div>
          <small>{label}</small>
          <strong>{value}</strong>
          <span>{unit}</span>
        </div>
        <i>{danger ? 'THRESHOLD BREACH' : 'WITHIN SLO'}</i>
      </header>
      <svg viewBox="0 0 560 120" role="img" aria-label={`${label} live trend`}>
        <defs>
          <linearGradient id={`fill-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".26" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline points={sparkline(values)} fill="none" stroke="currentColor" strokeWidth="3" />
        <polygon
          points={`0,120 ${sparkline(values)} 560,120`}
          fill={`url(#fill-${label})`}
        />
      </svg>
    </article>
  );
}

export function ProductionMonitor() {
  const [state, setState] = useState<DemoState>({
    phase: 'healthy',
    incidentId: 'INC-4821',
  });
  const [samples, setSamples] = useState<Sample[]>(() =>
    Array.from({ length: 34 }, (_, index) => healthySample(index)),
  );
  const [tick, setTick] = useState(34);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick(current => current + 1);
      setSamples(current => {
        const next =
          state.phase === 'healthy'
            ? healthySample(tick)
            : incidentSample(tick);
        return [...current.slice(-39), next];
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [state.phase, tick]);

  useEffect(() => {
    let navigating = false;
    const poll = async () => {
      const response = await fetch('/demo/state', { cache: 'no-store' });
      if (!response.ok) return;
      const next = (await response.json()) as DemoState;
      setState(next);
      if (
        !navigating &&
        next.sessionId &&
        (next.phase === 'investigating' || next.phase === 'decision')
      ) {
        navigating = true;
        window.setTimeout(() => {
          window.location.assign(`/sessions/${encodeURIComponent(next.sessionId!)}`);
        }, 4000);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => window.clearInterval(timer);
  }, []);

  const latest = samples.at(-1) ?? healthySample(0);
  const danger = state.phase !== 'healthy' && state.phase !== 'recovered';
  const logs = useMemo(
    () =>
      danger
        ? [
            'checkout/complete · 503 · deadline exceeded after 6.814s',
            'db.round_trips · 200 · request req-103',
            'checkout/complete · 503 · deadline exceeded after 6.310s',
            'pager.evaluate · checkout-svc · incident threshold crossed',
          ]
        : [
            'checkout/complete · 200 · 74ms',
            'payment.authorize · 200 · 41ms',
            'order_items.bulk_write · 200 · 18ms',
            'checkout/complete · 200 · 81ms',
          ],
    [danger],
  );

  return (
    <main className="production-monitor" data-state={danger ? 'incident' : 'healthy'}>
      <header className="production-header">
        <div className="production-brand">
          <span className="production-logo">C</span>
          <div>
            <p>Commerce production</p>
            <h1>checkout-svc</h1>
          </div>
        </div>
        <div className="ingestion-status">
          <span />
          <div>
            <small>Live telemetry ingestion</small>
            <strong>Datadog · PagerDuty · application logs</strong>
          </div>
        </div>
        <div className="production-clock">
          <small>San Francisco · production-us-west-2</small>
          <strong>{new Date().toLocaleTimeString([], { hour12: false })}</strong>
        </div>
      </header>

      <section className="production-hero">
        <div>
          <p>{danger ? 'Production incident detected' : 'Production overview'}</p>
          <h2>{danger ? 'Checkout is degrading.' : 'All systems operational.'}</h2>
          <span>
            {danger
              ? `${state.incidentId} · ONCALL dispatch in progress`
              : 'Continuously ingesting requests, service metrics, deploy events, and error logs.'}
          </span>
        </div>
        <div className="health-orbit" data-danger={danger || undefined}>
          <span />
          <strong>{danger ? 'SEV-1' : 'HEALTHY'}</strong>
          <small>{danger ? 'Page fired' : '99.99% SLO'}</small>
        </div>
      </section>

      <section className="production-grid">
        <MetricChart
          label="Request throughput"
          value={latest.requests.toLocaleString()}
          unit="req/min"
          values={samples.map(sample => sample.requests)}
          danger={false}
        />
        <MetricChart
          label="p99 latency"
          value={latest.p99.toLocaleString()}
          unit="milliseconds"
          values={samples.map(sample => sample.p99)}
          danger={danger}
        />
        <MetricChart
          label="Error rate"
          value={latest.errors.toFixed(2)}
          unit="percent"
          values={samples.map(sample => sample.errors)}
          danger={danger}
        />
      </section>

      <section className="production-lower-grid">
        <article className="service-topology">
          <header>
            <div>
              <small>Request path</small>
              <strong>Live service topology</strong>
            </div>
            <span>{latest.saturation}% saturation</span>
          </header>
          <div className="topology-flow">
            {['Edge', 'checkout-api', 'orders', 'PostgreSQL'].map((service, index) => (
              <div key={service} data-danger={danger && index > 1 ? true : undefined}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{service}</strong>
                <small>{danger && index > 1 ? 'DEGRADED' : 'HEALTHY'}</small>
              </div>
            ))}
          </div>
        </article>
        <article className="live-ingestion-stream">
          <header>
            <div>
              <small>Streaming events</small>
              <strong>Production ingestion</strong>
            </div>
            <span><i /> LIVE</span>
          </header>
          <ol>
            {logs.map((line, index) => (
              <li key={`${line}-${index}`} data-error={danger && index !== 3 ? true : undefined}>
                <time>{new Date(Date.now() - index * 1300).toLocaleTimeString([], { hour12: false })}</time>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </article>
      </section>

      {danger ? (
        <aside className="incident-dispatch-toast">
          <span>!</span>
          <div>
            <small>{state.incidentId} · automated dispatch</small>
            <strong>ONCALL is investigating</strong>
            <p>Four TrueForge specialists are starting in parallel.</p>
          </div>
          <div className="dispatch-delivery">
            <small>Slack #oncall-demo</small>
            <strong>{state.slackStatus === 'delivered' ? 'Delivered' : 'Sending…'}</strong>
          </div>
        </aside>
      ) : null}

      <footer className="production-footer">
        <span><i /> 12 collectors connected</span>
        <span>Last deploy · 14:30 UTC</span>
        <span>Retention · 30 days</span>
        <span>ONCALL automation · armed</span>
      </footer>
    </main>
  );
}
